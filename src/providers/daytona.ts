import { LineBuffer } from "../lines.js";
import { shellQuote, withEnvPrefix } from "./shell.js";
import { cancellable } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

interface DaytonaSandbox {
  id: string;
  process: {
    executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<{
      exitCode: number;
      result?: string;
      artifacts?: { stdout?: string };
    }>;
    createSession?(sessionId: string): Promise<void>;
    executeSessionCommand?(
      sessionId: string,
      req: { command: string; runAsync?: boolean },
      timeout?: number,
    ): Promise<{ cmdId?: string; exitCode?: number; stdout?: string; stderr?: string; output?: string }>;
    getSessionCommandLogs?(
      sessionId: string,
      commandId: string,
      onStdout?: (chunk: string) => void,
      onStderr?: (chunk: string) => void,
    ): Promise<{ stdout?: string; stderr?: string; output?: string }>;
    getSessionCommand?(sessionId: string, commandId: string): Promise<{ exitCode?: number }>;
    createPty?(opts: {
      id?: string;
      cwd?: string;
      cols?: number;
      rows?: number;
      onData?: (data: Uint8Array) => void;
    }): Promise<{
      sendInput(data: string | Uint8Array): Promise<void>;
      waitForConnection?(): Promise<void>;
      disconnect?(): Promise<void>;
    }>;
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
  terminal: true,
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
      return streamDaytona(sandbox, command, handlers);
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
    async attachTerminal(socket, size) {
      if (!sandbox.process.createPty) throw new Error("Daytona SDK is missing process.createPty");
      const handle = await sandbox.process.createPty({
        id: `boxrouter-${Date.now()}`,
        cwd: size.cwd,
        cols: size.cols,
        rows: size.rows,
        onData: (data) => socket.send(Buffer.from(data)),
      });
      await handle.waitForConnection?.();
      socket.onMessage((data) => {
        void handle.sendInput(data);
      });
      socket.onClose(() => {
        void handle.disconnect?.();
      });
    },
    async destroy() {
      await sandbox.delete();
    },
  };
}

function streamDaytona(sandbox: DaytonaSandbox, command: string, handlers: ExecHandlers) {
  const cancel = async () => undefined;
  const work = (async (): Promise<ExecResult> => {
    const sessioned = sandbox.process.createSession && sandbox.process.executeSessionCommand && sandbox.process.getSessionCommandLogs;
    if (!sessioned) return batchExec(sandbox, command, handlers);
    const sessionId = `boxrouter-${Date.now()}`;
    await sandbox.process.createSession!(sessionId);
    const wrapped = handlers.cwd ? `cd ${shellQuote(handlers.cwd)} && ${command}` : command;
    const started = await sandbox.process.executeSessionCommand!(
      sessionId,
      { command: withEnvPrefix(wrapped, handlers.env), runAsync: true },
      handlers.timeoutMs ? Math.ceil(handlers.timeoutMs / 1000) : undefined,
    );
    if (!started.cmdId) return batchExec(sandbox, command, handlers);
    const stdout = new LineBuffer();
    const stderr = new LineBuffer();
    let out = "";
    let err = "";
    await sandbox.process.getSessionCommandLogs!(
      sessionId,
      started.cmdId,
      (chunk) => {
        out += chunk;
        for (const line of stdout.push(chunk)) handlers.onStdout?.(line);
      },
      (chunk) => {
        err += chunk;
        for (const line of stderr.push(chunk)) handlers.onStderr?.(line);
      },
    );
    for (const line of stdout.flush()) handlers.onStdout?.(line);
    for (const line of stderr.flush()) handlers.onStderr?.(line);
    const finished = await sandbox.process.getSessionCommand?.(sessionId, started.cmdId);
    return { exitCode: finished?.exitCode ?? started.exitCode ?? 0, stdout: out, stderr: err };
  })();
  return cancellable(work, cancel, handlers.signal);
}

async function batchExec(sandbox: DaytonaSandbox, command: string, handlers: ExecHandlers): Promise<ExecResult> {
  const response = await sandbox.process.executeCommand(
    command,
    handlers.cwd,
    handlers.env,
    handlers.timeoutMs ? Math.ceil(handlers.timeoutMs / 1000) : undefined,
  );
  const stdout = response.artifacts?.stdout || response.result || "";
  for (const line of stdout.split("\n").filter(Boolean)) handlers.onStdout?.(line);
  return { exitCode: response.exitCode ?? 0, stdout, stderr: "" };
}
