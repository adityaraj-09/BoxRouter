import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { settings } from "./settings.js";
import type { ProviderSession } from "./types.js";

const token = randomBytes(18).toString("hex");
settings.headers.Authorization = `Bearer ${token}`;
const sessions = new Map<string, { session: ProviderSession; terminal: boolean }>();

let httpServer: http.Server | undefined;
let sockets: WebSocketServer | undefined;
let ready: Promise<number> | undefined;

export function registerSession(name: string, session: ProviderSession, terminal: boolean): void {
  sessions.set(name, { session, terminal });
}

export function unregisterSession(name: string): void {
  sessions.delete(name);
}

/** HTTP base Steer turns into `ws` and then appends `/terminal/ws`. */
export async function sandboxProcessUrl(name: string): Promise<string> {
  const port = await listen();
  return `http://127.0.0.1:${port}/s/${encodeURIComponent(name)}`;
}

export async function terminalTarget(name: string): Promise<{ url: string; headers: Record<string, string> }> {
  const base = await sandboxProcessUrl(name);
  const params = new URLSearchParams({ cols: "80", rows: "24" });
  return {
    url: `${base.replace(/^http/, "ws")}/terminal/ws?${params.toString()}`,
    headers: { ...settings.headers },
  };
}

function listen(): Promise<number> {
  if (!ready) {
    ready = new Promise((resolve) => {
      httpServer = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      sockets = new WebSocketServer({ server: httpServer });
      sockets.on("connection", (socket, request) => {
        const raw = (socket as WebSocket & { _socket?: { unref?: () => void } })._socket;
        raw?.unref?.();
        void accept(socket, request);
      });
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer?.unref();
        const address = httpServer?.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  }
  return ready;
}

async function accept(socket: WebSocket, request: http.IncomingMessage): Promise<void> {
  const header = request.headers.authorization;
  if (header !== `Bearer ${token}`) {
    socket.close(4401, "unauthorized");
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const nested = url.pathname.match(/^\/s\/([^/]+)\/terminal\/ws$/);
  const name = nested ? decodeURIComponent(nested[1] ?? "") : (url.searchParams.get("name") ?? "");
  if (!nested && url.pathname !== "/terminal/ws") {
    socket.close(4404, "not found");
    return;
  }
  const live = sessions.get(name);
  if (!live) {
    socket.send("Unknown sandbox\n");
    socket.close();
    return;
  }
  const wrapped = {
    send(data: string | Buffer) {
      if (socket.readyState === socket.OPEN) socket.send(data);
    },
    onMessage(listener: (data: Buffer) => void) {
      socket.on("message", (data) => listener(Buffer.from(data as Buffer)));
    },
    onClose(listener: () => void) {
      socket.on("close", () => listener());
    },
    close() {
      socket.close();
    },
  };
  try {
    await live.session.attachTerminal(wrapped, {
      cols: Number(url.searchParams.get("cols") ?? 80),
      rows: Number(url.searchParams.get("rows") ?? 24),
      cwd: url.searchParams.get("workingDir") || undefined,
      shell: url.searchParams.get("shell") || undefined,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    socket.send(`${text}\n`);
    socket.close();
  }
}
