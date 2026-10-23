import { createHash } from "node:crypto";
import { LineBuffer } from "../lines.js";
import { shellQuote } from "./shell.js";
import { cancellable } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession } from "../types.js";

const MAX_EXEC_TIMEOUT_MS = 300_000;

interface FreestyleDirEntry {
  name: string;
  kind?: string;
}

interface FreestylePty {
  sessionId: number;
  write(data: string | Uint8Array): void;
}

interface FreestyleVm {
  readonly id: string;
  exec(opts: string | { command: string; timeoutMs?: number; env?: Record<string, string> }): Promise<{
    stdout?: string | null;
    stderr?: string | null;
    statusCode?: number | null;
  }>;
  resize(opts: { cpu?: number; memory?: number }): Promise<unknown>;
  fs: { readDir(dir: string): Promise<FreestyleDirEntry[]> };
  pty: {
    open(opts: {
      cols?: number;
      rows?: number;
      exec?: string;
      onData?: (data: Uint8Array) => void;
      onExit?: (code: number) => void;
      onError?: (error: unknown) => void;
    }): Promise<FreestylePty>;
    close(session: number | string): Promise<unknown>;
  };
  start(): Promise<unknown>;
  delete(): Promise<void>;
}

interface FreestyleNamespace {
  create(opts: {
    firewall?: unknown;
    slug?: string | null;
    snapshotId?: string | null;
  }): Promise<{ vm: FreestyleVm; vmId: string; data: { resources?: { cpu?: number; memory?: number } } }>;
  get(id: string): Promise<{ id: string; state?: string }>;
  ref(id: string): FreestyleVm;
}

interface FreestyleClient {
  vms: FreestyleNamespace;
}

interface FreestyleModule {
  Freestyle: new (opts?: { apiKey?: string; baseUrl?: string }) => FreestyleClient;
}

async function loadFreestyle(): Promise<FreestyleModule> {
  try {
    return (await import("freestyle")) as unknown as FreestyleModule;
  } catch {
    throw new Error("Freestyle SDK is not installed. Run: npm install freestyle");
  }
}

function client(key: ProviderKey, mod: FreestyleModule): FreestyleClient {
  const apiKey = key.credentials.FREESTYLE_API_KEY;
  if (!apiKey) throw new Error("FREESTYLE_API_KEY missing on this key");
  return new mod.Freestyle({
    apiKey,
    baseUrl: key.credentials.FREESTYLE_API_URL || key.credentials.FREESTYLE_BASE_URL,
  });
}

/** Slugs are unique per account and limited to [a-z0-9-], so keep a stable hash suffix. */
function slugFor(name: string): string {
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 6);
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 55)
    .replace(/-$/, "");
  return `${base || "boxrouter"}-${hash}`;
}

const FIREWALL = { rules: [{ action: "allow", source: {}, destination: { public: true } }] };

export const freestyleDriver: ProviderDriver = {
  name: "freestyle",
  terminal: true,
  async create(key, request) {
    if (request.image && request.image.includes(":")) {
      throw new Error("Freestyle creates from a snapshot id, not a Docker image; pass a Freestyle snapshot id or omit image");
    }
    const mod = await loadFreestyle();
    const freestyle = client(key, mod);
    const created = await freestyle.vms.create({
      firewall: FIREWALL,
      slug: slugFor(request.name),
      snapshotId: request.image,
    });
    await growToFit(created.vm, created.data.resources, request);
    return freestyleSession(created.vm, created.vmId);
  },
  async resume(key, resourceId) {
    const mod = await loadFreestyle();
    const freestyle = client(key, mod);
    const info = await freestyle.vms.get(resourceId);
    if (info.state === "stopped" || info.state === "paused") {
      await freestyle.vms.ref(resourceId).start();
    }
    return freestyleSession(freestyle.vms.ref(resourceId), resourceId);
  },
};

/** Freestyle sizes VMs from the snapshot and only grows, so only ask for more than we got. */
async function growToFit(
  vm: FreestyleVm,
  current: { cpu?: number; memory?: number } | undefined,
  request: { cpu?: number; memoryMb?: number },
): Promise<void> {
  const next: { cpu?: number; memory?: number } = {};
  if (request.cpu && request.cpu > (current?.cpu ?? 0)) next.cpu = request.cpu;
  if (request.memoryMb && request.memoryMb > (current?.memory ?? 0)) next.memory = request.memoryMb;
  if (Object.keys(next).length) await vm.resize(next).catch(() => undefined);
}

function freestyleSession(vm: FreestyleVm, resourceId: string): ProviderSession {
  return {
    provider: "freestyle",
    resourceId,
    exec(command, handlers) {
      return streamFreestyle(vm, command, handlers);
    },
    async listDir(dir) {
      const entries = await vm.fs.readDir(dir);
      const directories = [];
      const files = [];
      for (const entry of entries) {
        const item = { name: entry.name, path: `${dir.replace(/\/$/, "")}/${entry.name}` };
        if (entry.kind === "directory") directories.push(item);
        else files.push(item);
      }
      return { directories, files };
    },
    async attachTerminal(socket, size) {
      const exec = size.cwd
        ? `cd ${shellQuote(size.cwd)} && exec ${shellQuote(size.shell || "sh")} -l`
        : size.shell
          ? shellQuote(size.shell)
          : undefined;
      const session = await vm.pty.open({
        cols: size.cols,
        rows: size.rows,
        exec,
        onData: (data) => socket.send(Buffer.from(data)),
        onExit: () => socket.close(),
        onError: () => socket.close(),
      });
      socket.onMessage((data) => {
        try {
          session.write(data);
        } catch {
          socket.close();
        }
      });
      socket.onClose(() => {
        void vm.pty.close(session.sessionId).catch(() => undefined);
      });
    },
    async destroy() {
      await vm.delete();
    },
  };
}

function streamFreestyle(vm: FreestyleVm, command: string, handlers: ExecHandlers) {
  const work = (async (): Promise<ExecResult> => {
    const line = handlers.cwd ? `cd ${shellQuote(handlers.cwd)} && ${command}` : command;
    const requested = handlers.timeoutMs && handlers.timeoutMs > 0 ? handlers.timeoutMs : MAX_EXEC_TIMEOUT_MS;
    const timeoutMs = Math.min(requested, MAX_EXEC_TIMEOUT_MS);
    const result = await vm.exec({ command: line, env: handlers.env, timeoutMs });
    const stdout = new LineBuffer();
    const stderr = new LineBuffer();
    for (const chunk of stdout.push(result.stdout ?? "")) handlers.onStdout?.(chunk);
    for (const chunk of stderr.push(result.stderr ?? "")) handlers.onStderr?.(chunk);
    for (const chunk of stdout.flush()) handlers.onStdout?.(chunk);
    for (const chunk of stderr.flush()) handlers.onStderr?.(chunk);
    return {
      exitCode: result.statusCode ?? 124,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  })();
  return cancellable(work, async () => undefined, handlers.signal);
}
