import { WebSocket } from "ws";
import type { TerminalSocket } from "../types.js";

/** Pipe a vendor PTY websocket onto BoxRouter's local terminal socket. */
export function pipeWebSocket(url: string, headers: Record<string, string>, socket: TerminalSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const remote = new WebSocket(url, { headers });
    remote.on("open", () => {
      socket.onMessage((data) => {
        if (remote.readyState === WebSocket.OPEN) remote.send(data);
      });
      socket.onClose(() => remote.close());
    });
    remote.on("message", (data) => socket.send(Buffer.from(data as Buffer)));
    remote.on("close", () => {
      socket.close();
      resolve();
    });
    remote.on("error", (error) => {
      socket.close();
      reject(error);
    });
  });
}

export function cancellable<T>(
  work: Promise<T>,
  cancel: () => Promise<void>,
  signal?: AbortSignal,
): Promise<T> & { cancel: () => Promise<void> } {
  const result = work as Promise<T> & { cancel: () => Promise<void> };
  result.cancel = cancel;
  signal?.addEventListener("abort", () => {
    void cancel();
  }, { once: true });
  return result;
}

type LiveEnv = { signature: string; done?: Promise<unknown> };
const liveEnv: LiveEnv[] = [];

/**
 * Scope SDK credentials onto process.env without cross-tenant bleed.
 * Calls with a different credential set wait for the currently scoped one to finish;
 * calls with identical values may run concurrently since they write the same values.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const signature = JSON.stringify(vars);
  const others = liveEnv.filter((entry) => entry.signature !== signature).map((entry) => entry.done!);
  const entry: LiveEnv = { signature };
  liveEnv.push(entry);
  const run = (async () => {
    if (others.length) await Promise.all(others);
    const previous: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(vars)) {
      previous[name] = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  })();
  entry.done = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
