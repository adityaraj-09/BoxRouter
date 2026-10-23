import { LineBuffer } from "../lines.js";
import { shellQuote, withEnvPrefix } from "./shell.js";
import { cancellable } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession } from "../types.js";

const DEFAULT_API = "https://boat.dev/api/v1";

interface BoatFrame {
  type?: string;
  data?: unknown;
  exitCode?: number | null;
  timedOut?: boolean;
  message?: string;
}

interface BoatClient {
  create(opts: Record<string, unknown>): Promise<{ sandbox?: { id?: string } }>;
  get(opts: { sandboxId: string }): Promise<{ sandbox?: { id?: string; state?: string } }>;
  resume(opts: { sandboxId: string }): Promise<unknown>;
  command(opts: {
    sandboxId: string;
    commandRequest: { command: string; cwd?: string; timeoutSeconds?: number };
  }): Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
  deleteSandbox(opts: { sandboxId: string; xAsciiConfirmDelete?: string }): Promise<unknown>;
}

interface BoatModule {
  BoatApi: new (config: unknown) => BoatClient;
  Configuration: new (opts: { basePath?: string; accessToken?: string }) => unknown;
  streamCommand: (
    boat: BoatClient,
    sandboxId: string,
    command: string,
    opts?: { cwd?: string; timeoutSeconds?: number; signal?: AbortSignal },
  ) => AsyncGenerator<BoatFrame>;
}

async function loadBoat(): Promise<BoatModule> {
  try {
    return (await import("@boatdev/sdk")) as unknown as BoatModule;
  } catch {
    throw new Error("Boat SDK is not installed. Run: npm install @boatdev/sdk");
  }
}

function client(key: ProviderKey, mod: BoatModule): BoatClient {
  const apiKey = key.credentials.BOAT_API_KEY;
  if (!apiKey) throw new Error("BOAT_API_KEY missing on this key");
  const basePath = (key.credentials.BOAT_API_URL || key.credentials.BOAT_API_BASE || DEFAULT_API).replace(/\/+$/, "");
  return new mod.BoatApi(new mod.Configuration({ basePath, accessToken: apiKey }));
}

function machineType(request: { cpu?: number; memoryMb?: number }): "small" | "default" | "large" | "xlarge" {
  const memoryGb = (request.memoryMb ?? 0) / 1024;
  const cpu = request.cpu ?? 0;
  if (memoryGb >= 32 || cpu >= 16) return "xlarge";
  if (memoryGb >= 16 || cpu >= 8) return "large";
  if ((memoryGb > 0 && memoryGb <= 4) || (cpu > 0 && cpu <= 2)) return "small";
  return "default";
}

function stopped(state: string | undefined): boolean {
  return state === "archived" || state === "archiving" || state === "stopped";
}

export const boatDriver: ProviderDriver = {
  name: "boat",
  terminal: false,
  async create(key, request) {
    const mod = await loadBoat();
    const boat = client(key, mod);
    const created = await boat.create({
      type: machineType(request),
      env: request.env,
      from: request.image,
    });
    const sandboxId = created.sandbox?.id;
    if (!sandboxId) throw new Error("Boat create returned no sandbox id");
    return boatSession(mod, boat, sandboxId);
  },
  async resume(key, resourceId) {
    const mod = await loadBoat();
    const boat = client(key, mod);
    const info = await boat.get({ sandboxId: resourceId });
    if (stopped(info.sandbox?.state)) await boat.resume({ sandboxId: resourceId });
    return boatSession(mod, boat, resourceId);
  },
};

function boatSession(mod: BoatModule, boat: BoatClient, sandboxId: string): ProviderSession {
  return {
    provider: "boat",
    resourceId: sandboxId,
    exec(command, handlers) {
      return streamBoat(mod, boat, sandboxId, command, handlers);
    },
    async listDir(dir) {
      const listed = await boat.command({
        sandboxId,
        commandRequest: {
          command: `cd ${shellQuote(dir)} && ls -1ap`,
          timeoutSeconds: 60,
        },
      });
      const directories = [];
      const files = [];
      for (const line of (listed.stdout ?? "").split("\n")) {
        if (!line.trim() || line === "./" || line === "../") continue;
        const isDir = line.endsWith("/");
        const name = isDir ? line.slice(0, -1) : line;
        const entry = { name, path: `${dir.replace(/\/$/, "")}/${name}` };
        if (isDir) directories.push(entry);
        else files.push(entry);
      }
      return { directories, files };
    },
    // Boat's HTTP API exposes a desktop and SSH, not an attachable PTY.
    async attachTerminal() {
      throw new Error("Boat does not expose an attachable PTY over its HTTP API; set terminal: false for this provider");
    },
    async destroy() {
      await boat.deleteSandbox({ sandboxId, xAsciiConfirmDelete: sandboxId });
    },
  };
}

function streamBoat(mod: BoatModule, boat: BoatClient, sandboxId: string, command: string, handlers: ExecHandlers) {
  const controller = new AbortController();
  const work = (async (): Promise<ExecResult> => {
    let line = withEnvPrefix(command, handlers.env);
    if (handlers.cwd) line = `cd ${shellQuote(handlers.cwd)} && ${line}`;
    const seconds = Math.min(600, Math.max(1, Math.ceil((handlers.timeoutMs ?? 600_000) / 1000)));
    const stdout = new LineBuffer();
    const stderr = new LineBuffer();
    let out = "";
    let err = "";
    let exitCode = 0;
    let sawExit = false;
    for await (const frame of mod.streamCommand(boat, sandboxId, line, {
      timeoutSeconds: seconds,
      signal: controller.signal,
    })) {
      if (frame.type === "stdout" || frame.type === "stderr") {
        const chunk = typeof frame.data === "string" ? frame.data : String(frame.data ?? "");
        if (frame.type === "stdout") {
          out += chunk;
          for (const item of stdout.push(chunk)) handlers.onStdout?.(item);
        } else {
          err += chunk;
          for (const item of stderr.push(chunk)) handlers.onStderr?.(item);
        }
      } else if (frame.type === "exit") {
        exitCode = frame.exitCode ?? (frame.timedOut ? 124 : 1);
        sawExit = true;
      } else if (frame.type === "error") {
        throw new Error(frame.message || "Boat command failed");
      }
    }
    for (const item of stdout.flush()) handlers.onStdout?.(item);
    for (const item of stderr.flush()) handlers.onStderr?.(item);
    if (!sawExit) throw new Error("Boat exec stream ended without an exit frame");
    return { exitCode, stdout: out, stderr: err };
  })();
  return cancellable(work, async () => controller.abort(), handlers.signal);
}
