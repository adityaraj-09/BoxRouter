import { LineBuffer } from "../lines.js";
import { cancellable, withEnv } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

interface VercelCommand {
  logs(): AsyncIterable<{ stream?: string; data?: string }>;
  wait(): Promise<{ exitCode?: number }>;
  writeStdin?(data: string | Buffer | Uint8Array): Promise<void>;
  kill?(): Promise<void>;
}

interface VercelSandbox {
  name?: string;
  sandboxId?: string;
  runCommand(cmd: string | Record<string, unknown>, args?: string[]): Promise<VercelCommand>;
  fs?: {
    readdir(path: string, opts?: { withFileTypes?: boolean }): Promise<Array<string | { name: string; isDirectory?: () => boolean }>>;
  };
  delete(): Promise<void>;
}

type VercelModule = {
  Sandbox: {
    create(opts: Record<string, unknown>): Promise<VercelSandbox>;
    get(opts: { name?: string; sandboxId?: string; resume?: boolean }): Promise<VercelSandbox>;
  };
};

async function loadVercel(): Promise<VercelModule> {
  try {
    return (await import("@vercel/sandbox")) as VercelModule;
  } catch {
    throw new Error("Vercel Sandbox SDK is not installed. Run: npm install @vercel/sandbox");
  }
}

function scoped<T>(key: ProviderKey, fn: () => Promise<T>): Promise<T> {
  if (!key.credentials.VERCEL_TOKEN) throw new Error("VERCEL_TOKEN missing on this key");
  return withEnv(
    {
      VERCEL_TOKEN: key.credentials.VERCEL_TOKEN,
      VERCEL_TEAM_ID: key.credentials.VERCEL_TEAM_ID,
      VERCEL_PROJECT_ID: key.credentials.VERCEL_PROJECT_ID,
    },
    fn,
  );
}

function auth(key: ProviderKey) {
  return {
    token: key.credentials.VERCEL_TOKEN,
    teamId: key.credentials.VERCEL_TEAM_ID,
    projectId: key.credentials.VERCEL_PROJECT_ID,
  };
}

export const vercelDriver: ProviderDriver = {
  name: "vercel",
  terminal: true,
  async create(key, request) {
    return scoped(key, async () => {
      const { Sandbox } = await loadVercel();
      const sandbox = await Sandbox.create({
        ...auth(key),
        name: request.name,
        runtime: request.image,
        env: request.env,
        resources: request.cpu ? { vcpus: request.cpu } : undefined,
      });
      return vercelSession(sandbox, request.name);
    });
  },
  async resume(key, resourceId) {
    return scoped(key, async () => {
      const { Sandbox } = await loadVercel();
      try {
        return vercelSession(await Sandbox.get({ ...auth(key), name: resourceId, resume: true }), resourceId);
      } catch {
        return vercelSession(await Sandbox.get({ ...auth(key), sandboxId: resourceId, resume: true }), resourceId);
      }
    });
  },
};

function vercelSession(sandbox: VercelSandbox, fallback: string): ProviderSession {
  const resourceId = sandbox.name || sandbox.sandboxId || fallback;
  return {
    provider: "vercel",
    resourceId,
    exec(command, handlers) {
      return streamVercel(sandbox, command, handlers);
    },
    async listDir(dir) {
      const entries = (await sandbox.fs?.readdir(dir, { withFileTypes: true })) ?? [];
      const directories = [];
      const files = [];
      for (const entry of entries) {
        if (typeof entry === "string") {
          files.push({ name: entry, path: `${dir.replace(/\/$/, "")}/${entry}` });
          continue;
        }
        const item = { name: entry.name, path: `${dir.replace(/\/$/, "")}/${entry.name}` };
        if (entry.isDirectory?.()) directories.push(item);
        else files.push(item);
      }
      return { directories, files };
    },
    async attachTerminal(socket, size) {
      const command = await sandbox.runCommand({
        cmd: size.shell || "bash",
        args: ["-l"],
        cwd: size.cwd,
        detached: true,
        stdin: true,
      });
      socket.onMessage((data) => {
        void command.writeStdin?.(data);
      });
      void (async () => {
        for await (const line of command.logs()) {
          if (line.data) socket.send(line.data);
        }
        socket.close();
      })();
    },
    async destroy() {
      await sandbox.delete();
    },
  };
}

function streamVercel(sandbox: VercelSandbox, command: string, handlers: ExecHandlers) {
  let handle: VercelCommand | undefined;
  const work = (async (): Promise<ExecResult> => {
    handle = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", command],
      cwd: handlers.cwd,
      env: handlers.env,
      detached: true,
      signal: handlers.signal,
    });
    const stdout = new LineBuffer();
    const stderr = new LineBuffer();
    let out = "";
    let err = "";
    for await (const line of handle.logs()) {
      const chunk = line.data ?? "";
      if (line.stream === "stderr") {
        err += chunk;
        for (const item of stderr.push(chunk.endsWith("\n") ? chunk : `${chunk}\n`)) handlers.onStderr?.(item);
      } else {
        out += chunk;
        for (const item of stdout.push(chunk.endsWith("\n") ? chunk : `${chunk}\n`)) handlers.onStdout?.(item);
      }
    }
    for (const line of stdout.flush()) handlers.onStdout?.(line);
    for (const line of stderr.flush()) handlers.onStderr?.(line);
    const finished = await handle.wait();
    return { exitCode: finished.exitCode ?? 0, stdout: out, stderr: err };
  })();
  return cancellable(work, async () => {
    await handle?.kill?.();
  }, handlers.signal);
}
