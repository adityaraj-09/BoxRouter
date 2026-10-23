import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { LineBuffer } from "../lines.js";
import type { CreateRequest, ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession, TerminalSocket } from "../types.js";

function run(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `a/b` and `a-b` sanitize to the same string, so a hash suffix keeps names collision-free. */
function containerName(name: string): string {
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  const base = name.replace(/[^a-z0-9_.-]/gi, "-").toLowerCase().replace(/^[^a-z0-9]+/, "").slice(0, 50) || "boxrouter";
  return `${base}-${hash}`;
}

export const dockerDriver: ProviderDriver = {
  name: "docker",
  terminal: true,
  async create(key, request) {
    const image = request.image || "python:3.12-slim";
    const name = containerName(request.name);
    const memory = request.memoryMb ? ["--memory", `${request.memoryMb}m`] : [];
    const created = await run(["run", "-d", "--name", name, ...memory, image, "sleep", "infinity"]);
    if (created.code !== 0) {
      throw new Error(created.stderr || created.stdout || "docker run failed");
    }
    const id = created.stdout.trim();
    return dockerSession(key, id);
  },
  async resume(key, resourceId) {
    const inspected = await run(["inspect", "-f", "{{.State.Running}}", resourceId]);
    if (inspected.code !== 0 || inspected.stdout.trim() !== "true") {
      throw new Error(`Docker sandbox ${resourceId} is not running`);
    }
    return dockerSession(key, resourceId);
  },
};

function dockerSession(_key: ProviderKey, resourceId: string): ProviderSession {
  return {
    provider: "docker",
    resourceId,
    exec(command, handlers) {
      return streamDocker(resourceId, command, handlers);
    },
    async listDir(dir) {
      const listed = await run([
        "exec",
        "-w",
        "/",
        resourceId,
        "sh",
        "-lc",
        `cd ${quote(dir)} && ls -1ap`,
      ]);
      const directories = [];
      const files = [];
      for (const line of listed.stdout.split("\n")) {
        if (!line.trim() || line === "../") continue;
        const isDir = line.endsWith("/");
        const name = isDir ? line.slice(0, -1) : line;
        const entry = { name, path: `${dir.replace(/\/$/, "")}/${name}` };
        if (isDir) directories.push(entry);
        else files.push(entry);
      }
      return { directories, files };
    },
    async attachTerminal(socket, size) {
      const child = spawn(
        "docker",
        [
          "exec",
          "-i",
          "-t",
          "-e",
          `COLUMNS=${size.cols}`,
          "-e",
          `LINES=${size.rows}`,
          ...(size.cwd ? ["-w", size.cwd] : []),
          resourceId,
          size.shell || "bash",
          "-l",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      pipeProcess(child, socket);
    },
    async destroy() {
      await run(["rm", "-f", resourceId]);
    },
  };
}

function streamDocker(resourceId: string, command: string, handlers: ExecHandlers) {
  const args = ["exec", "-i"];
  if (handlers.cwd) args.push("-w", handlers.cwd);
  for (const [name, value] of Object.entries(handlers.env ?? {})) {
    args.push("-e", `${name}=${value}`);
  }
  args.push(resourceId, "sh", "-c", command);
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  return bindChild(child, handlers);
}

function bindChild(child: ChildProcess, handlers: ExecHandlers) {
  const stdout = new LineBuffer();
  const stderr = new LineBuffer();
  let out = "";
  let err = "";
  let resolve: (result: ExecResult) => void = () => undefined;
  const result = new Promise<ExecResult>((done) => {
    resolve = done;
  });
  const finish = (exitCode: number) => {
    for (const line of stdout.flush()) handlers.onStdout?.(line);
    for (const line of stderr.flush()) handlers.onStderr?.(line);
    resolve({ exitCode, stdout: out, stderr: err });
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    out += chunk;
    for (const line of stdout.push(chunk)) handlers.onStdout?.(line);
  });
  child.stderr?.on("data", (chunk: string) => {
    err += chunk;
    for (const line of stderr.push(chunk)) handlers.onStderr?.(line);
  });
  child.on("close", (code) => finish(code ?? 1));
  child.on("error", () => finish(1));
  const cancel = async () => {
    child.kill("SIGKILL");
  };
  handlers.signal?.addEventListener("abort", () => {
    void cancel();
  }, { once: true });
  if (handlers.timeoutMs) {
    const timer = setTimeout(() => void cancel(), handlers.timeoutMs);
    void result.then(() => clearTimeout(timer));
  }
  const promise = result as Promise<ExecResult> & { cancel: () => Promise<void> };
  promise.cancel = cancel;
  return promise;
}

function pipeProcess(child: ChildProcess, socket: TerminalSocket) {
  child.stdout?.on("data", (chunk: Buffer) => socket.send(chunk));
  child.stderr?.on("data", (chunk: Buffer) => socket.send(chunk));
  socket.onMessage((data) => child.stdin?.write(data));
  socket.onClose(() => child.kill("SIGHUP"));
  child.on("close", () => socket.close());
}

export type { CreateRequest };
