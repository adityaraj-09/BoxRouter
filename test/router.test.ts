import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { SandboxInstance } from "../src/blaxel.js";
import { memoryDriver, scriptedStart } from "../src/providers/memory.js";
import { Router } from "../src/router.js";
import { JsonStore } from "../src/store.js";
import type { ProviderDriver, ProviderKey } from "../src/types.js";

function key(id: string, provider = "memory"): ProviderKey {
  return { id, provider, credentials: { E2B_API_KEY: `secret-${id}` }, limits: {} };
}

function countingDriver(creates: { n: number }): ProviderDriver {
  const base = memoryDriver(scriptedStart(["hello", "world"]));
  return {
    ...base,
    name: "memory",
    async create(providerKey, request) {
      creates.n += 1;
      return base.create(providerKey, request);
    },
  };
}

async function router(keys: ProviderKey[], driver: ProviderDriver, now = () => new Date("2026-10-18T12:00:00Z")) {
  const dir = await mkdtemp(path.join(tmpdir(), "boxrouter-"));
  return new Router({ organization: { name: "acme", markup: 2 }, keys }, new JsonStore(path.join(dir, "usage.json")), [driver], now);
}

test("round robin then reconnects the same sandbox by name", async () => {
  const creates = { n: 0 };
  const box = await router([key("a"), key("b")], countingDriver(creates));
  const first = await SandboxInstance.createIfNotExists({ name: "steer-room-agent" }, box);
  const second = await SandboxInstance.createIfNotExists({ name: "steer-room-other" }, box);
  const again = await SandboxInstance.createIfNotExists({ name: "steer-room-agent" }, box);
  assert.equal(creates.n, 2);
  const resumed = await SandboxInstance.get("steer-room-agent", box);
  assert.equal(creates.n, 2);
  assert.equal(resumed.metadata.name, first.metadata.name);
  await assert.rejects(() => SandboxInstance.get("missing", box));
  assert.equal(again.metadata.name, first.metadata.name);
  assert.notEqual(first.metadata.name, second.metadata.name);
  assert.match(first.getTerminalTarget().headers.Authorization, /^Bearer /);
  const raw = await readFile((box as unknown as { store: { file: string } }).store.file, "utf8");
  assert.equal(raw.includes("secret-a"), false);
  const stored = JSON.parse(raw) as { names: Record<string, { provider_resource_id?: string }> };
  assert.ok(stored.names["steer-room-agent"]?.provider_resource_id);
});

test("streams complete lines and supports abort", async () => {
  const box = await router([key("a")], memoryDriver(scriptedStart(["one", "two"])));
  const sandbox = await SandboxInstance.createIfNotExists({ name: "job" }, box);
  const lines: string[] = [];
  await sandbox.process.exec({ name: "cli", command: "claude", waitForCompletion: false });
  const stream = sandbox.process.streamLogs("cli", { onStdout: (line) => lines.push(line) });
  const result = await sandbox.process.wait("cli");
  stream.close();
  assert.deepEqual(lines, ["one", "two"]);
  assert.equal(result.exitCode, 0);
  assert.match(sandbox.process.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/job$/);
  const steerUrl = `${sandbox.process.url.replace(/^http/, "ws")}/terminal/ws?cols=40&rows=12`;
  assert.equal(sandbox.getTerminalTarget().url.startsWith(steerUrl.split("?")[0] ?? ""), true);
  assert.match(sandbox.getTerminalTarget().headers.Authorization, /^Bearer /);
});

test("terminal websocket speaks to the provider PTY", async () => {
  const box = await router([key("a")], memoryDriver(async (_command, _handlers, emit) => {
    emit.stdout("ok\n");
    emit.finish(0);
    return { cancel: async () => undefined };
  }));
  const sandbox = await SandboxInstance.createIfNotExists({ name: "term" }, box);
  const steerUrl = `${sandbox.process.url.replace(/^http/, "ws").replace(/\/+$/, "")}/terminal/ws?cols=80&rows=24&workingDir=/home/user/repo`;
  const target = { url: steerUrl, headers: sandbox.getTerminalTarget().headers };
  const received = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(target.url, { headers: target.headers });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("terminal timed out"));
    }, 2000);
    socket.on("message", (data) => {
      clearTimeout(timer);
      socket.close();
      resolve(String(data));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.match(received, /memory-pty/);
});

test("destroy records local price and a monthly cap blocks the next create", async () => {
  let now = new Date("2026-10-18T12:00:00Z");
  const priced = key("a", "e2b");
  priced.limits = { spend_usd_per_month: 0.01 };
  const driver: ProviderDriver = { ...memoryDriver(scriptedStart(["ok"])), name: "e2b" };
  const dir = await mkdtemp(path.join(tmpdir(), "boxrouter-"));
  const box = new Router(
    { organization: { name: "acme", markup: 2 }, keys: [priced] },
    new JsonStore(path.join(dir, "usage.json")),
    [driver],
    () => now,
  );
  const sandbox = await SandboxInstance.createIfNotExists({ name: "priced" }, box);
  now = new Date(now.getTime() + 60 * 60 * 1000);
  await sandbox.delete();
  const costs = await box.costs();
  assert.ok(Math.abs(costs.provider_usd - 0.083) < 1e-6);
  assert.ok(Math.abs(costs.customer_usd - 0.166) < 1e-6);
  await assert.rejects(() => SandboxInstance.createIfNotExists({ name: "next" }, box));
});
