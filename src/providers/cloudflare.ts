import { LineBuffer } from "../lines.js";
import { cancellable, pipeWebSocket } from "./ws-proxy.js";
import type { ExecHandlers, ExecResult, ProviderDriver, ProviderKey, ProviderSession } from "../types.js";

function creds(key: ProviderKey) {
  const apiUrl = (key.credentials.CLOUDFLARE_SANDBOX_URL || key.credentials.SANDBOX_API_URL || "").replace(/\/+$/, "");
  const apiKey = key.credentials.CLOUDFLARE_SANDBOX_API_KEY || key.credentials.SANDBOX_API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error("CLOUDFLARE_SANDBOX_URL and CLOUDFLARE_SANDBOX_API_KEY missing on this key (Cloudflare sandbox bridge)");
  }
  return { apiUrl, apiKey };
}

async function cfFetch(key: ProviderKey, path: string, init: RequestInit = {}): Promise<Response> {
  const { apiUrl, apiKey } = creds(key);
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok && response.status !== 204) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Cloudflare ${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`);
  }
  return response;
}

export const cloudflareDriver: ProviderDriver = {
  name: "cloudflare",
  terminal: true,
  async create(key, request) {
    const response = await cfFetch(key, "/v1/sandbox", {
      method: "POST",
      body: JSON.stringify({ image: request.image, env: request.env, name: request.name }),
    });
    const created = (await response.json()) as { id: string };
    return cloudflareSession(key, created.id);
  },
  async resume(key, resourceId) {
    await cfFetch(key, `/v1/sandbox/${encodeURIComponent(resourceId)}/running`);
    return cloudflareSession(key, resourceId);
  },
};

function cloudflareSession(key: ProviderKey, resourceId: string): ProviderSession {
  return {
    provider: "cloudflare",
    resourceId,
    exec(command, handlers) {
      return streamCloudflare(key, resourceId, command, handlers);
    },
    async listDir(dir) {
      const listed = await streamCloudflare(
        key,
        resourceId,
        `find ${shellQuote(dir)} -mindepth 1 -maxdepth 1 -printf '%y %s %P\\n'`,
        {},
      );
      const directories = [];
      const files = [];
      for (const line of listed.stdout.split("\n")) {
        if (!line.trim()) continue;
        const [kind, size, ...nameParts] = line.split(" ");
        const name = nameParts.join(" ");
        const item = { name, path: `${dir.replace(/\/$/, "")}/${name}`, sizeBytes: Number(size) || 0 };
        if (kind === "d") directories.push(item);
        else files.push(item);
      }
      return { directories, files };
    },
    async attachTerminal(socket, size) {
      const { apiUrl, apiKey } = creds(key);
      const ws = apiUrl.replace(/^http/, "ws");
      const params = new URLSearchParams({ cols: String(size.cols), rows: String(size.rows) });
      if (size.shell) params.set("shell", size.shell);
      await pipeWebSocket(
        `${ws}/v1/sandbox/${encodeURIComponent(resourceId)}/pty?${params}`,
        { Authorization: `Bearer ${apiKey}` },
        socket,
      );
    },
    async destroy() {
      await cfFetch(key, `/v1/sandbox/${encodeURIComponent(resourceId)}`, { method: "DELETE" });
    },
  };
}

function streamCloudflare(key: ProviderKey, resourceId: string, command: string, handlers: ExecHandlers) {
  const controller = new AbortController();
  const work = (async (): Promise<ExecResult> => {
    const argv = handlers.cwd ? ["sh", "-lc", `cd ${shellQuote(handlers.cwd)} && ${command}`] : ["sh", "-lc", command];
    const response = await cfFetch(key, `/v1/sandbox/${encodeURIComponent(resourceId)}/exec`, {
      method: "POST",
      body: JSON.stringify({ argv, timeout_ms: handlers.timeoutMs ?? 600_000, cwd: handlers.cwd }),
      signal: controller.signal,
    });
    return readCloudflareSse(response, handlers);
  })();
  return cancellable(work, async () => controller.abort(), handlers.signal);
}

export async function readCloudflareSse(response: Response, handlers: ExecHandlers): Promise<ExecResult> {
  if (!response.body) throw new Error("Cloudflare exec returned no body");
  const stdout = new LineBuffer();
  const stderr = new LineBuffer();
  let out = "";
  let err = "";
  let exitCode = 0;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  let event = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      applyCloudflareEvent(event, data, handlers, stdout, stderr, (chunk, stream) => {
        if (stream === "stdout") out += chunk;
        else if (stream === "stderr") err += chunk;
        else exitCode = Number(chunk) || 0;
      });
      event = "";
    }
  }
  for (const line of stdout.flush()) handlers.onStdout?.(line);
  for (const line of stderr.flush()) handlers.onStderr?.(line);
  return { exitCode, stdout: out, stderr: err };
}

function applyCloudflareEvent(
  event: string,
  data: string,
  handlers: ExecHandlers,
  stdout: LineBuffer,
  stderr: LineBuffer,
  record: (chunk: string, stream: "stdout" | "stderr" | "exit") => void,
) {
  if (event === "stdout" || event === "stderr") {
    const chunk = decodeChunk(data);
    record(chunk, event);
    const buffer = event === "stdout" ? stdout : stderr;
    const emit = event === "stdout" ? handlers.onStdout : handlers.onStderr;
    for (const line of buffer.push(chunk)) emit?.(line);
    return;
  }
  if (event === "exit" || event === "complete") {
    try {
      const parsed = JSON.parse(data) as { exit_code?: number; exitCode?: number };
      record(String(parsed.exit_code ?? parsed.exitCode ?? 0), "exit");
    } catch {
      record(data, "exit");
    }
  }
}

function decodeChunk(data: string): string {
  try {
    const parsed = JSON.parse(data) as { data?: string };
    if (parsed.data) return parsed.data;
  } catch {
    // Bridge docs send raw base64.
  }
  try {
    return Buffer.from(data, "base64").toString("utf8");
  } catch {
    return data;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
