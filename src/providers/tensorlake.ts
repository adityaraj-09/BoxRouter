import { LineBuffer } from "../lines.js";
import { cancellable, withEnv } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

interface TensorlakeSandbox {
  sandboxId?: string;
  sandbox_id?: string;
  name?: string;
  run(
    command: string,
    opts?: { args?: string[]; env?: Record<string, string>; timeout?: number; workingDir?: string },
  ): Promise<{ exitCode?: number; exit_code?: number; stdout?: string; stderr?: string }>;
  startProcess?(
    command: string,
    opts?: { args?: string[]; env?: Record<string, string>; workingDir?: string },
  ): Promise<{ pid: number }>;
  followOutput?(pid: number): AsyncIterable<{ line?: string; data?: string; stream?: string }>;
  killProcess?(pid: number): Promise<void>;
  listDirectory?(path: string): Promise<Array<{ name: string; path?: string; isDir?: boolean; is_dir?: boolean; size?: number }> | { entries?: Array<{ name: string; path?: string; isDir?: boolean; is_dir?: boolean; size?: number }> }>;
  createPty?(opts: {
    command?: string;
    cols?: number;
    rows?: number;
    workingDir?: string;
    onData?: (data: Uint8Array) => void;
  }): Promise<{ sendInput(data: string | Uint8Array): Promise<void> }>;
  terminate?(): Promise<void>;
  delete?(): Promise<void>;
}

type TensorlakeModule = {
  Sandbox: {
    create(opts: Record<string, unknown>): Promise<TensorlakeSandbox>;
    connect(id: string): Promise<TensorlakeSandbox> | TensorlakeSandbox;
  };
};

async function loadTensorlake(): Promise<TensorlakeModule> {
  try {
    return (await import("@tensorlakeai/tensorlake")) as TensorlakeModule;
  } catch {
    throw new Error("Tensorlake SDK is not installed. Run: npm install @tensorlakeai/tensorlake");
  }
}

function scoped<T>(key: ProviderKey, fn: () => Promise<T>): Promise<T> {
  if (!key.credentials.TENSORLAKE_API_KEY) throw new Error("TENSORLAKE_API_KEY missing on this key");
  return withEnv({ TENSORLAKE_API_KEY: key.credentials.TENSORLAKE_API_KEY }, fn);
}

export const tensorlakeDriver: ProviderDriver = {
  name: "tensorlake",
  terminal: true,
  async create(key, request) {
    return scoped(key, async () => {
      const { Sandbox } = await loadTensorlake();
      const sandbox = await Sandbox.create({
        name: request.name,
        image: request.image,
        cpus: request.cpu,
        memoryMb: request.memoryMb,
        env: request.env,
      });
      return tensorlakeSession(sandbox);
    });
  },
  async resume(key, resourceId) {
    return scoped(key, async () => {
      const { Sandbox } = await loadTensorlake();
      return tensorlakeSession(await Sandbox.connect(resourceId));
    });
  },
};

function resourceId(sandbox: TensorlakeSandbox): string {
  return sandbox.sandboxId || sandbox.sandbox_id || sandbox.name || "";
}

function tensorlakeSession(sandbox: TensorlakeSandbox): ProviderSession {
  return {
    provider: "tensorlake",
    resourceId: resourceId(sandbox),
    exec(command, handlers) {
      return streamTensorlake(sandbox, command, handlers);
    },
    async listDir(dir) {
      if (!sandbox.listDirectory) return { directories: [], files: [] };
      const listed = await sandbox.listDirectory(dir);
      const entries = Array.isArray(listed) ? listed : (listed.entries ?? []);
      const directories = [];
      const files = [];
      for (const entry of entries) {
        const item = { name: entry.name, path: entry.path || `${dir.replace(/\/$/, "")}/${entry.name}`, sizeBytes: entry.size };
        if (entry.isDir || entry.is_dir) directories.push(item);
        else files.push(item);
      }
      return { directories, files };
    },
    async attachTerminal(socket, size) {
      if (!sandbox.createPty) throw new Error("Tensorlake SDK is missing createPty");
      const pty = await sandbox.createPty({
        command: size.shell || "/bin/bash",
        cols: size.cols,
        rows: size.rows,
        workingDir: size.cwd,
        onData: (data) => socket.send(Buffer.from(data)),
      });
      socket.onMessage((data) => {
        void pty.sendInput(data);
      });
    },
    async destroy() {
      await (sandbox.terminate ?? sandbox.delete)?.();
    },
  };
}

function streamTensorlake(sandbox: TensorlakeSandbox, command: string, handlers: ExecHandlers) {
  let pid: number | undefined;
  const work = (async (): Promise<ExecResult> => {
    if (sandbox.startProcess && sandbox.followOutput) {
      const proc = await sandbox.startProcess("bash", {
        args: ["-lc", command],
        env: handlers.env,
        workingDir: handlers.cwd,
      });
      pid = proc.pid;
      const stdout = new LineBuffer();
      const stderr = new LineBuffer();
      let out = "";
      let err = "";
      for await (const event of sandbox.followOutput(proc.pid)) {
        const chunk = event.line ?? event.data ?? "";
        if (!chunk) continue;
        if (event.stream === "stderr") {
          err += chunk.endsWith("\n") ? chunk : `${chunk}\n`;
          for (const line of stderr.push(chunk.endsWith("\n") ? chunk : `${chunk}\n`)) handlers.onStderr?.(line);
        } else {
          out += chunk.endsWith("\n") ? chunk : `${chunk}\n`;
          for (const line of stdout.push(chunk.endsWith("\n") ? chunk : `${chunk}\n`)) handlers.onStdout?.(line);
        }
      }
      for (const line of stdout.flush()) handlers.onStdout?.(line);
      for (const line of stderr.flush()) handlers.onStderr?.(line);
      return { exitCode: 0, stdout: out, stderr: err };
    }
    const finished = await sandbox.run("bash", {
      args: ["-lc", command],
      env: handlers.env,
      timeout: handlers.timeoutMs ? Math.ceil(handlers.timeoutMs / 1000) : undefined,
      workingDir: handlers.cwd,
    });
    const stdout = finished.stdout ?? "";
    const stderr = finished.stderr ?? "";
    for (const line of stdout.split("\n").filter(Boolean)) handlers.onStdout?.(line);
    for (const line of stderr.split("\n").filter(Boolean)) handlers.onStderr?.(line);
    return { exitCode: finished.exitCode ?? finished.exit_code ?? 0, stdout, stderr };
  })();
  return cancellable(work, async () => {
    if (pid != null) await sandbox.killProcess?.(pid);
  }, handlers.signal);
}
