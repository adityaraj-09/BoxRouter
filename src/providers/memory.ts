import type { CreateRequest, ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

export interface StartedCommand {
  cancel: () => Promise<void>;
  result: Promise<ExecResult>;
}

export type CommandStarter = (
  command: string,
  handlers: ExecHandlers,
  emit: {
    stdout: (chunk: string) => void;
    stderr: (chunk: string) => void;
    finish: (exitCode: number) => void;
  },
) => Promise<{ cancel: () => Promise<void> }>;

/** In-memory provider used by tests and as the shape real providers follow. */
export function memoryDriver(start: CommandStarter, options?: { terminal?: boolean }): ProviderDriver {
  return {
    name: "memory",
    terminal: options?.terminal ?? true,
    async create(key, request) {
      return session(`${key.id}:${request.name}:${Date.now()}`, start, options?.terminal ?? true);
    },
    async resume(_key, resourceId) {
      return session(resourceId, start, options?.terminal ?? true);
    },
  };
}

function session(resourceId: string, start: CommandStarter, terminal: boolean): ProviderSession {
  return {
    provider: "memory",
    resourceId,
    exec(command, handlers) {
      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      let resolve: (result: ExecResult) => void = () => undefined;
      const result = new Promise<ExecResult>((done) => {
        resolve = done;
      });
      const emit = {
        stdout(chunk: string) {
          stdout += chunk;
          for (const line of chunk.split("\n")) {
            if (line) handlers.onStdout?.(line);
          }
        },
        stderr(chunk: string) {
          stderr += chunk;
          for (const line of chunk.split("\n")) {
            if (line) handlers.onStderr?.(line);
          }
        },
        finish(code: number) {
          exitCode = code;
          resolve({ exitCode, stdout, stderr });
        },
      };
      let cancel = async () => emit.finish(130);
      const pending = start(command, handlers, emit).then((handle) => {
        cancel = handle.cancel;
      });
      const promise = pending.then(() => result) as Promise<ExecResult> & { cancel: () => Promise<void> };
      promise.cancel = () => cancel();
      handlers.signal?.addEventListener("abort", () => {
        void cancel();
      });
      return promise;
    },
    async listDir() {
      return { directories: [], files: [] };
    },
    async attachTerminal(socket: TerminalSocket) {
      if (!terminal) throw new Error("This provider has no PTY");
      socket.send("memory-pty\n");
      socket.onMessage((data) => socket.send(data));
    },
    async destroy() {},
  };
}

export function scriptedStart(lines: string[]): CommandStarter {
  return async (_command, _handlers, emit) => {
    queueMicrotask(() => {
      for (const line of lines) emit.stdout(`${line}\n`);
      emit.finish(0);
    });
    return { cancel: async () => emit.finish(130) };
  };
}

export type { CreateRequest };
