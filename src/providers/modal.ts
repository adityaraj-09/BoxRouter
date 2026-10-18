import { LineBuffer } from "../lines.js";
import { cancellable } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

interface ModalProcess {
  stdout: AsyncIterable<string> & { readText?(): Promise<string> };
  stderr: AsyncIterable<string> & { readText?(): Promise<string> };
  stdin?: { write?(data: string | Uint8Array): Promise<void>; writeText?(data: string): Promise<void> };
  wait?(): Promise<number | { exitCode?: number }>;
  kill?(): Promise<void>;
  terminate?(): Promise<void>;
}

interface ModalSandbox {
  sandboxId: string;
  exec(command: string[], opts?: Record<string, unknown>): Promise<ModalProcess>;
  filesystem?: {
    listFiles?(path: string): Promise<Array<{ name: string; type?: string | { value?: string }; size?: number }>>;
  };
  terminate(): Promise<void>;
}

type ModalModule = {
  ModalClient: new (opts?: { tokenId?: string; tokenSecret?: string }) => {
    apps: { fromName(name: string, opts?: { createIfMissing?: boolean }): Promise<unknown> };
    images: { fromRegistry(image: string): unknown };
    sandboxes: {
      create(app: unknown, image: unknown, opts?: Record<string, unknown>): Promise<ModalSandbox>;
      fromId(id: string): Promise<ModalSandbox>;
    };
  };
};

async function loadModal(): Promise<ModalModule> {
  try {
    return (await import("modal")) as ModalModule;
  } catch {
    throw new Error("Modal SDK is not installed. Run: npm install modal");
  }
}

function client(key: ProviderKey, ModalClient: ModalModule["ModalClient"]) {
  const tokenId = key.credentials.MODAL_TOKEN_ID;
  const tokenSecret = key.credentials.MODAL_TOKEN_SECRET;
  if (!tokenId || !tokenSecret) throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET missing on this key");
  return new ModalClient({ tokenId, tokenSecret });
}

export const modalDriver: ProviderDriver = {
  name: "modal",
  terminal: true,
  async create(key, request) {
    const { ModalClient } = await loadModal();
    const modal = client(key, ModalClient);
    const app = await modal.apps.fromName(key.credentials.MODAL_APP || "boxrouter", { createIfMissing: true });
    const image = modal.images.fromRegistry(request.image || "python:3.12-slim");
    const sandbox = await modal.sandboxes.create(app, image, {
      env: request.env,
      cpu: request.cpu,
      memoryMiB: request.memoryMb,
      timeoutMs: 60 * 60 * 1000,
    });
    return modalSession(sandbox);
  },
  async resume(key, resourceId) {
    const { ModalClient } = await loadModal();
    return modalSession(await client(key, ModalClient).sandboxes.fromId(resourceId));
  },
};

function modalSession(sandbox: ModalSandbox): ProviderSession {
  return {
    provider: "modal",
    resourceId: sandbox.sandboxId,
    exec(command, handlers) {
      return streamModal(sandbox, command, handlers);
    },
    async listDir(dir) {
      const entries = (await sandbox.filesystem?.listFiles?.(dir)) ?? [];
      const directories = [];
      const files = [];
      for (const entry of entries) {
        const kind = typeof entry.type === "string" ? entry.type : entry.type?.value;
        const item = { name: entry.name, path: `${dir.replace(/\/$/, "")}/${entry.name}`, sizeBytes: entry.size };
        if (kind === "directory" || kind === "dir") directories.push(item);
        else files.push(item);
      }
      return { directories, files };
    },
    async attachTerminal(socket, size) {
      const proc = await sandbox.exec([size.shell || "bash", "-l"], {
        pty: true,
        workdir: size.cwd,
      });
      socket.onMessage((data) => {
        void proc.stdin?.write?.(data);
        void proc.stdin?.writeText?.(data.toString());
      });
      void (async () => {
        for await (const chunk of proc.stdout) socket.send(chunk);
        socket.close();
      })();
    },
    async destroy() {
      await sandbox.terminate();
    },
  };
}

function streamModal(sandbox: ModalSandbox, command: string, handlers: ExecHandlers) {
  let proc: ModalProcess | undefined;
  const work = (async (): Promise<ExecResult> => {
    proc = await sandbox.exec(["bash", "-lc", command], {
      workdir: handlers.cwd,
      env: handlers.env,
      timeoutMs: handlers.timeoutMs,
    });
    const stdout = new LineBuffer();
    const stderr = new LineBuffer();
    let out = "";
    let err = "";
    await Promise.all([
      (async () => {
        for await (const chunk of proc!.stdout) {
          out += chunk;
          for (const line of stdout.push(chunk)) handlers.onStdout?.(line);
        }
      })(),
      (async () => {
        for await (const chunk of proc!.stderr) {
          err += chunk;
          for (const line of stderr.push(chunk)) handlers.onStderr?.(line);
        }
      })(),
    ]);
    for (const line of stdout.flush()) handlers.onStdout?.(line);
    for (const line of stderr.flush()) handlers.onStderr?.(line);
    const waited = await proc.wait?.();
    const exitCode = typeof waited === "number" ? waited : waited?.exitCode ?? 0;
    return { exitCode, stdout: out, stderr: err };
  })();
  return cancellable(work, async () => {
    await (proc?.kill ?? proc?.terminate)?.();
  }, handlers.signal);
}
