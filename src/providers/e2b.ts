import { LineBuffer } from "../lines.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

interface E2BSandbox {
  sandboxId: string;
  commands: {
    run(
      command: string,
      opts: {
        background?: boolean;
        cwd?: string;
        envs?: Record<string, string>;
        timeoutMs?: number;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
      },
    ): Promise<{ exitCode: number; stdout: string; stderr: string; wait?: () => Promise<{ exitCode: number; stdout: string; stderr: string }>; kill?: () => Promise<void> }>;
  };
  pty: {
    create(opts: {
      cols: number;
      rows: number;
      cwd?: string;
      timeoutMs?: number;
      onData: (data: Uint8Array) => void;
    }): Promise<{ pid: number }>;
    sendInput(pid: number, data: Uint8Array): Promise<void>;
  };
  files: {
    list(path: string): Promise<Array<{ name: string; path: string; type: string; size?: number }>>;
  };
  kill(): Promise<void>;
}

type E2BModule = {
  Sandbox: {
    create(opts: { apiKey: string; timeoutMs?: number }): Promise<E2BSandbox>;
    connect(id: string, opts: { apiKey: string }): Promise<E2BSandbox>;
  };
};

async function loadE2B(): Promise<E2BModule> {
  try {
    return (await import("e2b")) as E2BModule;
  } catch {
    throw new Error("E2B SDK is not installed. Run: npm install e2b");
  }
}

function apiKey(key: ProviderKey): string {
  const value = key.credentials.E2B_API_KEY;
  if (!value) throw new Error("E2B_API_KEY missing on this key");
  return value;
}

export const e2bDriver: ProviderDriver = {
  name: "e2b",
  terminal: true,
  async create(key, request) {
    const { Sandbox } = await loadE2B();
    const sandbox = await Sandbox.create({ apiKey: apiKey(key), timeoutMs: 60 * 60 * 1000 });
    if (request.env && Object.keys(request.env).length) {
      await sandbox.commands.run("true", { envs: request.env });
    }
    return e2bSession(sandbox);
  },
  async resume(key, resourceId) {
    const { Sandbox } = await loadE2B();
    const sandbox = await Sandbox.connect(resourceId, { apiKey: apiKey(key) });
    return e2bSession(sandbox);
  },
};

function e2bSession(sandbox: E2BSandbox): ProviderSession {
  return {
    provider: "e2b",
    resourceId: sandbox.sandboxId,
    exec(command, handlers) {
      return streamE2B(sandbox, command, handlers);
    },
    async listDir(dir) {
      const entries = await sandbox.files.list(dir);
      const directories = [];
      const files = [];
      for (const entry of entries) {
        const item = { name: entry.name, path: entry.path, sizeBytes: entry.size };
        if (entry.type === "dir") directories.push(item);
        else files.push(item);
      }
      return { directories, files };
    },
    async attachTerminal(socket, size) {
      const terminal = await sandbox.pty.create({
        cols: size.cols,
        rows: size.rows,
        cwd: size.cwd,
        timeoutMs: 0,
        onData: (data) => socket.send(Buffer.from(data)),
      });
      socket.onMessage((data) => {
        void sandbox.pty.sendInput(terminal.pid, data);
      });
    },
    async destroy() {
      await sandbox.kill();
    },
  };
}

function streamE2B(sandbox: E2BSandbox, command: string, handlers: ExecHandlers) {
  const stdout = new LineBuffer();
  const stderr = new LineBuffer();
  let out = "";
  let err = "";
  let cancel = async () => undefined;
  const promise = (async () => {
    const handle = await sandbox.commands.run(command, {
      background: true,
      cwd: handlers.cwd,
      envs: handlers.env,
      timeoutMs: handlers.timeoutMs ?? 0,
      onStdout: (data) => {
        out += data;
        for (const line of stdout.push(data)) handlers.onStdout?.(line);
      },
      onStderr: (data) => {
        err += data;
        for (const line of stderr.push(data)) handlers.onStderr?.(line);
      },
    });
    cancel = async () => {
      await handle.kill?.();
    };
    handlers.signal?.addEventListener("abort", () => {
      void cancel();
    }, { once: true });
    const finished = handle.wait ? await handle.wait() : handle;
    for (const line of stdout.flush()) handlers.onStdout?.(line);
    for (const line of stderr.flush()) handlers.onStderr?.(line);
    return {
      exitCode: finished.exitCode,
      stdout: finished.stdout || out,
      stderr: finished.stderr || err,
    } satisfies ExecResult;
  })();
  const result = promise as Promise<ExecResult> & { cancel: () => Promise<void> };
  result.cancel = () => cancel();
  return result;
}
