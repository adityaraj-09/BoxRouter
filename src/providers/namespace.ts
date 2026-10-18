import { LineBuffer } from "../lines.js";
import { cancellable } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

interface NamespaceDevbox {
  id?: string;
  name: string;
  exec(
    argv: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string>;
      onStdout?: (data: Uint8Array) => void;
      onStderr?: (data: Uint8Array) => void;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<{ exitCode?: number | null; stdout?: string; stderr?: string }>;
  terminal: {
    open(opts?: { columns?: number; rows?: number; env?: Record<string, string> }): Promise<{
      write(data: string | Uint8Array): void;
      close(): void;
      onData(listener: (data: Uint8Array) => void): () => void;
    }>;
  };
  fs?: { readdir(path: string): Promise<Array<{ name: string; type?: string }>> };
  delete?(): Promise<void>;
  destroy?(): Promise<void>;
}

interface NamespaceClient {
  devboxes: {
    create(opts: Record<string, unknown>): Promise<NamespaceDevbox>;
    get(name: string): Promise<NamespaceDevbox>;
    delete?(name: string): Promise<void>;
  };
  close(): void;
}

type NamespaceModule = {
  createDevboxClient(opts?: { tokenSource?: unknown; baseUrl?: string }): NamespaceClient;
};

type AuthModule = {
  fromBearerToken(token: string): unknown;
};

async function loadNamespace(): Promise<{ sdk: NamespaceModule; auth?: AuthModule }> {
  try {
    const sdk = (await import("@namespacelabs/sdk/devbox")) as NamespaceModule;
    let auth: AuthModule | undefined;
    try {
      auth = (await import("@namespacelabs/sdk/auth")) as AuthModule;
    } catch {
      auth = undefined;
    }
    return { sdk, auth };
  } catch {
    throw new Error("Namespace SDK is not installed. Run: npm install @namespacelabs/sdk");
  }
}

function token(key: ProviderKey): string | undefined {
  return key.credentials.NSC_TOKEN || key.credentials.NAMESPACE_TOKEN;
}

async function client(key: ProviderKey): Promise<NamespaceClient> {
  const { sdk, auth } = await loadNamespace();
  const bearer = token(key);
  return sdk.createDevboxClient({
    tokenSource: bearer && auth ? auth.fromBearerToken(bearer) : undefined,
    baseUrl: key.credentials.NSC_DEVBOX_ENDPOINT,
  });
}

export const namespaceDriver: ProviderDriver = {
  name: "namespace",
  terminal: true,
  async create(key, request) {
    const ns = await client(key);
    const sandbox = await ns.devboxes.create({
      name: request.name,
      imageName: request.image || "builtin:default",
      env: request.env,
    });
    return namespaceSession(ns, sandbox);
  },
  async resume(key, resourceId) {
    const ns = await client(key);
    return namespaceSession(ns, await ns.devboxes.get(resourceId));
  },
};

function namespaceSession(ns: NamespaceClient, sandbox: NamespaceDevbox): ProviderSession {
  return {
    provider: "namespace",
    resourceId: sandbox.name || sandbox.id || "",
    exec(command, handlers) {
      return streamNamespace(sandbox, command, handlers);
    },
    async listDir(dir) {
      const entries = (await sandbox.fs?.readdir(dir)) ?? [];
      const directories = [];
      const files = [];
      for (const entry of entries) {
        const item = { name: entry.name, path: `${dir.replace(/\/$/, "")}/${entry.name}` };
        if (entry.type === "directory") directories.push(item);
        else files.push(item);
      }
      return { directories, files };
    },
    async attachTerminal(socket, size) {
      const term = await sandbox.terminal.open({ columns: size.cols, rows: size.rows });
      term.onData((data) => socket.send(Buffer.from(data)));
      socket.onMessage((data) => term.write(data));
      socket.onClose(() => term.close());
    },
    async destroy() {
      await sandbox.delete?.();
      await sandbox.destroy?.();
      await ns.devboxes.delete?.(sandbox.name);
      ns.close();
    },
  };
}

function streamNamespace(sandbox: NamespaceDevbox, command: string, handlers: ExecHandlers) {
  const controller = new AbortController();
  const work = (async (): Promise<ExecResult> => {
    const stdout = new LineBuffer();
    const stderr = new LineBuffer();
    const finished = await sandbox.exec(["bash", "-lc", command], {
      cwd: handlers.cwd,
      env: handlers.env,
      timeoutMs: handlers.timeoutMs,
      signal: handlers.signal ?? controller.signal,
      onStdout: (data) => {
        const chunk = Buffer.from(data).toString("utf8");
        for (const line of stdout.push(chunk)) handlers.onStdout?.(line);
      },
      onStderr: (data) => {
        const chunk = Buffer.from(data).toString("utf8");
        for (const line of stderr.push(chunk)) handlers.onStderr?.(line);
      },
    });
    for (const line of stdout.flush()) handlers.onStdout?.(line);
    for (const line of stderr.flush()) handlers.onStderr?.(line);
    return {
      exitCode: finished.exitCode ?? 0,
      stdout: finished.stdout ?? "",
      stderr: finished.stderr ?? "",
    };
  })();
  return cancellable(work, async () => controller.abort(), handlers.signal);
}
