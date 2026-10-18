import type { ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

/**
 * Daytona can run a command, but its public API does not hand the browser a
 * PTY websocket. Commands are executed through the TypeScript SDK when it is
 * installed, and the terminal socket reports that a PTY is unavailable.
 */
interface DaytonaSandbox {
  id: string;
  process: {
    executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<{ exitCode: number; result?: string; artifacts?: { stdout?: string } }>;
  };
  fs: {
    listFiles(path: string): Promise<Array<{ name: string; path?: string; isDir: boolean; size?: number }>>;
  };
  delete(): Promise<void>;
}

type DaytonaModule = {
  Daytona: new (opts: { apiKey: string; apiUrl?: string }) => {
    create(params: { snapshot?: string; envVars?: Record<string, string>; labels?: Record<string, string> }): Promise<DaytonaSandbox>;
    get(id: string): Promise<DaytonaSandbox>;
  };
};

async function loadDaytona(): Promise<DaytonaModule> {
  try {
    return (await import("@daytonaio/sdk")) as DaytonaModule;
  } catch {
    throw new Error("Daytona SDK is not installed. Run: npm install @daytonaio/sdk");
  }
}

function client(key: ProviderKey, Daytona: DaytonaModule["Daytona"]) {
  return new Daytona({
    apiKey: key.credentials.DAYTONA_API_KEY ?? "",
    apiUrl: key.credentials.DAYTONA_API_URL,
  });
}

export const daytonaDriver: ProviderDriver = {
  name: "daytona",
  terminal: false,
  async create(key, request) {
    if (!key.credentials.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY missing on this key");
    const { Daytona } = await loadDaytona();
    const sandbox = await client(key, Daytona).create({
      snapshot: request.image,
      envVars: request.env,
      labels: { app: "boxrouter", name: request.name },
    });
    return daytonaSession(sandbox);
  },
  async resume(key, resourceId) {
    const { Daytona } = await loadDaytona();
    const sandbox = await client(key, Daytona).get(resourceId);
    return daytonaSession(sandbox);
  },
};

function daytonaSession(sandbox: DaytonaSandbox): ProviderSession {
  return {
    provider: "daytona",
    resourceId: sandbox.id,
    exec(command, handlers) {
      const promise = (async () => {
        const response = await sandbox.process.executeCommand(
          command,
          handlers.cwd,
          handlers.env,
          handlers.timeoutMs ? Math.ceil(handlers.timeoutMs / 1000) : undefined,
        );
        const stdout = response.artifacts?.stdout || response.result || "";
        const lines = stdout.split("\n").filter(Boolean);
        for (const line of lines) handlers.onStdout?.(line);
        return { exitCode: response.exitCode ?? 0, stdout, stderr: "" };
      })();
      const result = promise as typeof promise & { cancel: () => Promise<void> };
      result.cancel = async () => {
        throw new Error("Daytona command cancel is not supported");
      };
      handlers.signal?.addEventListener("abort", () => {
        void result.cancel();
      }, { once: true });
      return result;
    },
    async listDir(dir) {
      const entries = await sandbox.fs.listFiles(dir);
      const directories = [];
      const files = [];
      for (const entry of entries) {
        const item = { name: entry.name, path: entry.path || `${dir}/${entry.name}`, sizeBytes: entry.size };
        if (entry.isDir) directories.push(item);
        else files.push(item);
      }
      return { directories, files };
    },
    async attachTerminal(_socket: TerminalSocket) {
      throw new Error("Daytona does not expose a browser PTY websocket");
    },
    async destroy() {
      await sandbox.delete();
    },
  };
}
