import { LineBuffer } from "../lines.js";
import { shellQuote, withEnvPrefix } from "./shell.js";
import { cancellable, pipeWebSocket } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession } from "../types.js";

const DEFAULT_API = "https://run-us.isorun.ai";

function creds(key: ProviderKey) {
  const apiKey = key.credentials.ISORUN_API_KEY;
  if (!apiKey) throw new Error("ISORUN_API_KEY missing on this key");
  return { apiKey, apiUrl: (key.credentials.ISORUN_API_URL || DEFAULT_API).replace(/\/+$/, "") };
}

async function isorunFetch(key: ProviderKey, path: string, init: RequestInit = {}): Promise<Response> {
  const { apiKey, apiUrl } = creds(key);
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Isorun ${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  }
  return response;
}

export const isorunDriver: ProviderDriver = {
  name: "isorun",
  terminal: true,
  async create(key, request) {
    const response = await isorunFetch(key, "/v1/runs", {
      method: "POST",
      body: JSON.stringify({
        image: request.image || "python:3.12-slim",
        vcpus: request.cpu ?? 1,
        mem_mib: request.memoryMb ?? 1024,
        env: request.env,
      }),
    });
    const created = (await response.json()) as { id: string };
    return isorunSession(key, created.id);
  },
  async resume(key, resourceId) {
    await isorunFetch(key, `/v1/runs/${encodeURIComponent(resourceId)}`);
    return isorunSession(key, resourceId);
  },
};

function isorunSession(key: ProviderKey, resourceId: string): ProviderSession {
  return {
    provider: "isorun",
    resourceId,
    exec(command, handlers) {
      return streamIsorun(key, resourceId, command, handlers);
    },
    async listDir(dir) {
      const response = await isorunFetch(key, `/v1/runs/${encodeURIComponent(resourceId)}/files?path=${encodeURIComponent(dir)}`);
      const body = (await response.json()) as { entries?: Array<{ name: string; path?: string; type?: string; is_dir?: boolean; size?: number }> } | Array<{ name: string; path?: string; type?: string; is_dir?: boolean; size?: number }>;
      const entries = Array.isArray(body) ? body : (body.entries ?? []);
      const directories = [];
      const files = [];
      for (const entry of entries) {
        const item = { name: entry.name, path: entry.path || `${dir.replace(/\/$/, "")}/${entry.name}`, sizeBytes: entry.size };
        if (entry.is_dir || entry.type === "dir") directories.push(item);
        else files.push(item);
      }
      return { directories, files };
    },
    async attachTerminal(socket, size) {
      const { apiKey, apiUrl } = creds(key);
      const ws = apiUrl.replace(/^http/, "ws");
      const params = new URLSearchParams({ cols: String(size.cols), rows: String(size.rows) });
      if (size.cwd) params.set("cwd", size.cwd);
      await pipeWebSocket(`${ws}/v1/runs/${encodeURIComponent(resourceId)}/terminal?${params}`, { Authorization: `Bearer ${apiKey}` }, socket);
    },
    async destroy() {
      await isorunFetch(key, `/v1/runs/${encodeURIComponent(resourceId)}`, { method: "DELETE" });
    },
  };
}

function streamIsorun(key: ProviderKey, resourceId: string, command: string, handlers: ExecHandlers) {
  const controller = new AbortController();
  const work = (async (): Promise<ExecResult> => {
    const wrapped = handlers.cwd ? `cd ${shellQuote(handlers.cwd)} && ${command}` : command;
    const response = await isorunFetch(key, `/v1/runs/${encodeURIComponent(resourceId)}/exec/stream`, {
      method: "POST",
      body: JSON.stringify({
        command: withEnvPrefix(wrapped, handlers.env),
        timeout: handlers.timeoutMs ? Math.ceil(handlers.timeoutMs / 1000) : 600,
      }),
      signal: controller.signal,
    });
    return readSse(response, handlers);
  })();
  return cancellable(work, async () => controller.abort(), handlers.signal);
}

export async function readSse(response: Response, handlers: ExecHandlers): Promise<ExecResult> {
  if (!response.body) throw new Error("Isorun exec/stream returned no body");
  const stdout = new LineBuffer();
  const stderr = new LineBuffer();
  let out = "";
  let err = "";
  let exitCode = 0;
  let sawExit = false;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) applyFrame(line, handlers, stdout, stderr, (chunk, stream) => {
      if (stream === "stdout") out += chunk;
      else if (stream === "stderr") err += chunk;
      else {
        exitCode = Number(chunk) || 0;
        sawExit = true;
      }
    });
  }
  if (rest) applyFrame(rest, handlers, stdout, stderr, (chunk, stream) => {
    if (stream === "stdout") out += chunk;
    else if (stream === "stderr") err += chunk;
    else {
      exitCode = Number(chunk) || 0;
      sawExit = true;
    }
  });
  for (const line of stdout.flush()) handlers.onStdout?.(line);
  for (const line of stderr.flush()) handlers.onStderr?.(line);
  if (!sawExit) throw new Error("Isorun exec stream ended without an exit frame");
  return { exitCode, stdout: out, stderr: err };
}

function applyFrame(
  line: string,
  handlers: ExecHandlers,
  stdout: LineBuffer,
  stderr: LineBuffer,
  record: (chunk: string, stream: "stdout" | "stderr" | "exit") => void,
) {
  const payload = line.startsWith("data: ") ? line.slice(6) : line.trim();
  if (!payload) return;
  let frame: { type?: string; data?: string; code?: number };
  try {
    frame = JSON.parse(payload) as { type?: string; data?: string; code?: number };
  } catch {
    return;
  }
  if (frame.type === "stdout" && frame.data) {
    record(frame.data, "stdout");
    for (const item of stdout.push(frame.data)) handlers.onStdout?.(item);
  } else if (frame.type === "stderr" && frame.data) {
    record(frame.data, "stderr");
    for (const item of stderr.push(frame.data)) handlers.onStderr?.(item);
  } else if (frame.type === "exit") {
    record(String(frame.code ?? frame.data ?? 0), "exit");
  }
}
