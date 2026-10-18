import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Router } from "../src/router.js";
import { JsonStore } from "../src/store.js";
import { SandboxInstance } from "../src/blaxel.js";
import { blaxelDriver } from "../src/providers/blaxel.js";
import { e2bDriver } from "../src/providers/e2b.js";
import { vercelDriver } from "../src/providers/vercel.js";
import type { BoxRouterConfig } from "../src/types.js";

const wanted = new Set(["e2b", "blaxel", "vercel"]);
const raw = JSON.parse(await readFile("boxrouter.json", "utf8")) as BoxRouterConfig;
const keys = raw.keys.filter((key) => wanted.has(key.provider));
const dir = await mkdtemp(path.join(tmpdir(), "boxrouter-rr-"));
const usageFile = path.join(dir, "usage.json");
const router = new Router(
  { organization: raw.organization, keys },
  new JsonStore(usageFile),
  [e2bDriver, blaxelDriver, vercelDriver],
);

const stamp = Date.now();
const names = [`br-rr-a-${stamp}`, `br-rr-b-${stamp}`, `br-rr-c-${stamp}`];
const created: string[] = [];

try {
  for (const name of names) {
    await SandboxInstance.createIfNotExists({ name }, router);
    created.push(name);
  }
  const again = await SandboxInstance.createIfNotExists({ name: names[0]! }, router);
  const sandbox = await SandboxInstance.get(names[1]!, router);
  const lines: string[] = [];
  await sandbox.process.exec({
    name: "probe",
    command: "echo boxrouter-live && uname -s",
    waitForCompletion: false,
  });
  sandbox.process.streamLogs("probe", { onStdout: (line) => lines.push(line) });
  const result = await sandbox.process.wait("probe", { maxWait: 120_000 });

  const store = JSON.parse(await readFile(usageFile, "utf8")) as {
    cursor: number;
    names: Record<string, { keyId: string; provider: string }>;
  };
  const order = names.map((name) => store.names[name]?.provider);
  console.log(
    JSON.stringify(
      {
        order,
        keys: names.map((name) => store.names[name]?.keyId),
        reconnectFirst: again.metadata.name === names[0],
        midExec: { name: names[1], provider: store.names[names[1]!]?.provider, exit: result.exitCode, streamed: lines },
        uniqueProviders: new Set(order).size,
        nextCursor: store.cursor,
      },
      null,
      2,
    ),
  );
  if (new Set(order).size !== 3) throw new Error(`expected 3 vendors, got ${order.join(",")}`);
  if (result.exitCode !== 0 || !lines.some((line) => line.includes("boxrouter-live"))) {
    throw new Error("mid-rotation exec failed");
  }
} finally {
  for (const name of created) {
    try {
      await SandboxInstance.delete(name, router);
      console.log("destroyed", name);
    } catch (error) {
      console.error("destroy failed", name, error instanceof Error ? error.message : error);
    }
  }
}
