import { LineBuffer } from "../lines.js";
import { cancellable, pipeWebSocket, withEnv } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

interface VendorSandbox {
  metadata?: { name?: string; url?: string };
  url?: string;
  process: {
    url?: string;
    headers?: Record<string, string>;
    exec(opts: {
      name?: string;
      command: string;
      workingDir?: string;
      env?: Record<string, string>;
      timeout?: number;
      waitForCompletion?: boolean;
    }): Promise<{ exitCode?: number; stdout?: string; stderr?: string } | void>;
    streamLogs(name: string, handlers: { onStdout?: (line: string) => void; onStderr?: (line: string) => void }): { close: () => void };
    wait(name: string): Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
    kill(name: string): Promise<void>;
  };
  fs?: {
    ls(dir: string): Promise<{
      subdirectories?: Array<{ name: string; path: string }>;
      files?: Array<{ name: string; path: string; size?: number }>;
    }>;
  };
  delete(): Promise<void>;
}

type BlaxelModule = {
  SandboxInstance: {
    createIfNotExists(opts: Record<string, unknown>): Promise<VendorSandbox>;
    get(name: string): Promise<VendorSandbox>;
  };
};

async function loadBlaxel(): Promise<BlaxelModule> {
  try {
    return (await import("@blaxel/core")) as BlaxelModule;
  } catch {
    throw new Error("Blaxel SDK is not installed. Run: npm install @blaxel/core");
  }
}

function scoped<T>(key: ProviderKey, fn: () => Promise<T>): Promise<T> {
  if (!key.credentials.BL_API_KEY) throw new Error("BL_API_KEY missing on this key");
  return withEnv(
    {
      BL_API_KEY: key.credentials.BL_API_KEY,
      BL_WORKSPACE: key.credentials.BL_WORKSPACE,
    },
    fn,
  );
}

export const blaxelDriver: ProviderDriver = {
  name: "blaxel",
  terminal: true,
  async create(key, request) {
    return scoped(key, async () => {
      const { SandboxInstance } = await loadBlaxel();
      const sandbox = await SandboxInstance.createIfNotExists({
        name: request.name,
        image: request.image,
        memory: request.memoryMb,
        region: request.region || key.credentials.BL_REGION || "us-pdx-1",
        envs: request.env,
        labels: request.labels,
        externalId: request.externalId,
      });
      return blaxelSession(sandbox, request.name);
    });
  },
  async resume(key, resourceId) {
    return scoped(key, async () => {
      const { SandboxInstance } = await loadBlaxel();
      return blaxelSession(await SandboxInstance.get(resourceId), resourceId);
    });
  },
};

function blaxelSession(sandbox: VendorSandbox, fallbackName: string): ProviderSession {
  const resourceId = sandbox.metadata?.name || fallbackName;
  return {
    provider: "blaxel",
    resourceId,
    exec(command, handlers) {
      return streamBlaxel(sandbox, command, handlers);
    },
    async listDir(dir) {
      const listed = await sandbox.fs?.ls(dir);
      return {
        directories: listed?.subdirectories ?? [],
        files: (listed?.files ?? []).map((file) => ({ name: file.name, path: file.path, sizeBytes: file.size })),
      };
    },
    async attachTerminal(socket, size) {
      const base = sandbox.process.url || sandbox.metadata?.url || sandbox.url;
      if (!base) throw new Error("Blaxel sandbox has no process URL");
      const ws = base.replace(/^http/, "ws").replace(/\/+$/, "");
      const params = new URLSearchParams({
        cols: String(size.cols),
        rows: String(size.rows),
      });
      if (size.cwd) params.set("workingDir", size.cwd);
      await pipeWebSocket(`${ws}/terminal/ws?${params}`, sandbox.process.headers ?? {}, socket);
    },
    async destroy() {
      await sandbox.delete();
    },
  };
}

function streamBlaxel(sandbox: VendorSandbox, command: string, handlers: ExecHandlers) {
  const name = `boxrouter-${Date.now()}`;
  let closed = false;
  const work = (async (): Promise<ExecResult> => {
    await sandbox.process.exec({
      name,
      command,
      workingDir: handlers.cwd,
      env: handlers.env,
      timeout: handlers.timeoutMs ? Math.ceil(handlers.timeoutMs / 1000) : undefined,
      waitForCompletion: false,
    });
    const stdout = new LineBuffer();
    const stderr = new LineBuffer();
    let out = "";
    let err = "";
    const stream = sandbox.process.streamLogs(name, {
      onStdout: (line) => {
        out += `${line}\n`;
        for (const item of stdout.push(`${line}\n`)) handlers.onStdout?.(item);
      },
      onStderr: (line) => {
        err += `${line}\n`;
        for (const item of stderr.push(`${line}\n`)) handlers.onStderr?.(item);
      },
    });
    try {
      const finished = await sandbox.process.wait(name);
      for (const line of stdout.flush()) handlers.onStdout?.(line);
      for (const line of stderr.flush()) handlers.onStderr?.(line);
      return {
        exitCode: finished.exitCode ?? 0,
        stdout: finished.stdout || out,
        stderr: finished.stderr || err,
      };
    } finally {
      if (!closed) stream.close();
    }
  })();
  return cancellable(work, async () => {
    closed = true;
    await sandbox.process.kill(name);
  }, handlers.signal);
}
