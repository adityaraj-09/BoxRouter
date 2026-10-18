import type { ExecHandlers, ExecResult } from "./types.js";
import type { LiveSandbox } from "./router.js";
import { Router } from "./router.js";
import { settings } from "./settings.js";
import { registerSession, sandboxProcessUrl, terminalTarget, unregisterSession } from "./terminal.js";

export interface BlaxelExecOptions {
  name: string;
  command: string;
  workingDir?: string;
  env?: Record<string, string> | Array<{ name: string; value: string }>;
  keepAlive?: boolean;
  /** Seconds, matching Blaxel's process.exec timeout. */
  timeout?: number;
  waitForCompletion?: boolean;
}

export interface BlaxelCreateOptions {
  name: string;
  image?: string;
  memory?: number;
  /** Accepted so a Steer `createIfNotExists` literal type-checks. Idle TTL is not enforced here. */
  ttl?: string;
  lifecycle?: {
    expirationPolicies?: Array<{ type?: string; value?: string; action?: string }>;
  };
  region?: string;
  envs?: Array<{ name: string; value: string }> | Record<string, string>;
  labels?: Record<string, string>;
  externalId?: string;
  /** Limit the round-robin to one BoxRouter provider. */
  backend?: string;
}

let defaultRouter: Router | undefined;

/** Install the router used when Steer calls `SandboxInstance.get(name)` with no extra argument. */
export function useRouter(router: Router): void {
  defaultRouter = router;
}

function needRouter(router?: Router): Router {
  const chosen = router ?? defaultRouter;
  if (!chosen) throw new Error("Call useRouter() before SandboxInstance, or pass a router");
  return chosen;
}

interface Running {
  lines: { stdout: string[]; stderr: string[] };
  subscribers: Array<{ onStdout?: (line: string) => void; onStderr?: (line: string) => void }>;
  task: Promise<ExecResult> & { cancel: () => Promise<void> };
  result?: ExecResult;
}

/**
 * Drop-in shape for the subset of `@blaxel/core` SandboxInstance that Steer uses.
 * Routing, reconnect, streaming, and the terminal URL live behind these methods.
 */
export class SandboxInstance {
  readonly metadata: { name: string };
  status = "RUNNING";
  readonly process: ProcessAPI;
  readonly fs: FileAPI;
  private terminalTargetValue: { url: string; headers: Record<string, string> } = {
    url: "",
    headers: {},
  };

  private constructor(
    private readonly live: LiveSandbox,
    private readonly router: Router,
  ) {
    this.metadata = { name: live.name };
    this.process = new ProcessAPI(live);
    this.fs = new FileAPI(live);
  }

  static async createIfNotExists(opts: BlaxelCreateOptions, router?: Router): Promise<SandboxInstance> {
    const box = needRouter(router);
    const live = await box.open({
      name: opts.name,
      image: opts.image,
      memoryMb: opts.memory,
      env: envRecord(opts.envs),
      backend: opts.backend,
      labels: opts.labels,
      externalId: opts.externalId,
      region: opts.region,
    });
    return SandboxInstance.bind(live, box);
  }

  /** Resume the sandbox stored under `name`. Throws when that name was never created. */
  static async get(name: string, router?: Router): Promise<SandboxInstance> {
    const box = needRouter(router);
    const live = await box.resume(name);
    return SandboxInstance.bind(live, box);
  }

  static async delete(name: string, router?: Router): Promise<void> {
    const box = needRouter(router);
    unregisterSession(name);
    await box.destroy(name);
  }

  static async list(
    query?: { labels?: Record<string, string> },
    router?: Router,
  ): Promise<Array<{ name: string; metadata: { name: string } }>> {
    return needRouter(router).list(query?.labels);
  }

  async unarchive(): Promise<void> {}

  /** `{ url, headers }` for the provider PTY, when this provider has one. */
  getTerminalTarget(): { url: string; headers: Record<string, string> } {
    return { url: this.terminalTargetValue.url, headers: { ...this.terminalTargetValue.headers } };
  }

  /** Run a command to completion, forwarding each complete line. */
  exec(command: string, handlers: ExecHandlers = {}): Promise<ExecResult> & { cancel: () => Promise<void> } {
    return this.live.session.exec(command, handlers);
  }

  private static async bind(live: LiveSandbox, router: Router): Promise<SandboxInstance> {
    registerSession(live.name, live.session, live.terminal);
    const instance = new SandboxInstance(live, router);
    const target = await terminalTarget(live.name);
    instance.terminalTargetValue = target;
    instance.process.url = await sandboxProcessUrl(live.name);
    instance.process.headers = { ...settings.headers };
    return instance;
  }

  async delete(): Promise<void> {
    await SandboxInstance.delete(this.live.name, this.router);
  }
}

class ProcessAPI {
  url = "";
  headers: Record<string, string> = {};
  private readonly running = new Map<string, Running>();

  constructor(private readonly live: LiveSandbox) {}

  async exec(opts: BlaxelExecOptions): Promise<void> {
    const bucket: Running = {
      lines: { stdout: [], stderr: [] },
      subscribers: [],
      task: undefined as unknown as Running["task"],
    };
    const task = this.live.session.exec(opts.command, {
      cwd: opts.workingDir,
      env: envRecord(opts.env),
      timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
      onStdout: (line) => publish(bucket, "stdout", line),
      onStderr: (line) => publish(bucket, "stderr", line),
    });
    bucket.task = task;
    void task.then((result) => {
      bucket.result = result;
    });
    this.running.set(opts.name, bucket);
    if (opts.waitForCompletion !== false) await task;
  }

  streamLogs(
    name: string,
    handlers: { onStdout?: (line: string) => void; onStderr?: (line: string) => void },
  ): { close: () => void } {
    const bucket = this.require(name);
    const stdout = bucket.lines.stdout.slice();
    const stderr = bucket.lines.stderr.slice();
    bucket.subscribers.push(handlers);
    for (const line of stdout) handlers.onStdout?.(line);
    for (const line of stderr) handlers.onStderr?.(line);
    return {
      close: () => {
        bucket.subscribers = bucket.subscribers.filter((item) => item !== handlers);
      },
    };
  }

  async wait(name: string, opts?: { maxWait?: number; signal?: AbortSignal }): Promise<{ exitCode: number; stdout: string; stderr: string; status: string }> {
    const bucket = this.require(name);
    if (opts?.signal?.aborted) {
      await bucket.task.cancel();
      throw new Error("Aborted");
    }
    const onAbort = () => {
      void bucket.task.cancel();
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        bucket.task,
        opts?.maxWait
          ? new Promise<ExecResult>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("Timed out")), opts.maxWait);
            })
          : undefined,
      ].filter(Boolean) as Promise<ExecResult>[]);
      return { ...result, status: "completed" };
    } finally {
      if (timer) clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }

  async kill(name: string): Promise<void> {
    await this.require(name).task.cancel();
  }

  async stop(name: string): Promise<void> {
    await this.kill(name);
  }

  async get(name: string): Promise<{ status: string }> {
    const bucket = this.running.get(name);
    if (!bucket) return { status: "unknown" };
    return { status: bucket.result ? "completed" : "running" };
  }

  private require(name: string): Running {
    const bucket = this.running.get(name);
    if (!bucket) throw new Error(`No process named ${name}`);
    return bucket;
  }
}

class FileAPI {
  constructor(private readonly live: LiveSandbox) {}

  async ls(dir: string): Promise<{ subdirectories: Array<{ name: string; path: string }>; files: Array<{ name: string; path: string; size?: number }> }> {
    const listed = await this.live.session.listDir(dir);
    return {
      subdirectories: listed.directories,
      files: listed.files.map((file) => ({ name: file.name, path: file.path, size: file.sizeBytes })),
    };
  }
}

function publish(bucket: Running, stream: "stdout" | "stderr", line: string): void {
  bucket.lines[stream].push(line);
  for (const subscriber of bucket.subscribers) {
    if (stream === "stdout") subscriber.onStdout?.(line);
    else subscriber.onStderr?.(line);
  }
}

function envRecord(
  envs: BlaxelCreateOptions["envs"] | BlaxelExecOptions["env"],
): Record<string, string> | undefined {
  if (!envs) return undefined;
  if (!Array.isArray(envs)) return envs;
  return Object.fromEntries(envs.filter((item) => item.value).map((item) => [item.name, item.value]));
}
