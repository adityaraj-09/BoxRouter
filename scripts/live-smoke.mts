import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Router } from "../src/router.js";
import { JsonStore } from "../src/store.js";
import { SandboxInstance } from "../src/blaxel.js";
import { blaxelDriver } from "../src/providers/blaxel.js";
import { e2bDriver } from "../src/providers/e2b.js";
import { vercelDriver } from "../src/providers/vercel.js";
import type { BoxRouterConfig } from "../src/types.js";
import { readFile } from "node:fs/promises";

const backends = (process.argv.slice(2) as Array<"e2b" | "blaxel" | "vercel">);
const selected = backends.length ? backends : (["e2b", "blaxel", "vercel"] as const);

function redact(text: string): string {
  return text
    .replace(/e2b_[a-z0-9]+/gi, "e2b_[redacted]")
    .replace(/bl_[a-z0-9]+/gi, "bl_[redacted]")
    .replace(/vcp_[A-Za-z0-9]+/g, "vcp_[redacted]")
    .replace(/team_[A-Za-z0-9]+/g, "team_[redacted]")
    .replace(/prj_[A-Za-z0-9]+/g, "prj_[redacted]");
}

async function smoke(backend: (typeof backends)[number], router: Router) {
  const name = `br-live-${backend}-${Date.now()}`;
  const lines: string[] = [];
  console.log(`\n== ${backend} create ${name} ==`);
  const sandbox = await SandboxInstance.createIfNotExists({ name, backend }, router);
  try {
    await sandbox.process.exec({
      name: "probe",
      command: "echo boxrouter-live && uname -s",
      waitForCompletion: false,
    });
    sandbox.process.streamLogs("probe", {
      onStdout: (line) => lines.push(line),
      onStderr: (line) => lines.push(`err:${line}`),
    });
    const result = await sandbox.process.wait("probe", { maxWait: 120_000 });
    const again = await SandboxInstance.get(name, router);
    const listed = await again.fs.ls("/");
    console.log(
      JSON.stringify({
        provider: backend,
        create: "ok",
        execExit: result.exitCode,
        streamed: lines,
        reconnect: again.metadata.name === name,
        listedRoot: listed.subdirectories.length + listed.files.length,
        terminal: sandbox.getTerminalTarget().url ? "url" : "missing",
      }),
    );
    if (result.exitCode !== 0) throw new Error(`${backend} exec exited ${result.exitCode}`);
    if (!lines.some((line) => line.includes("boxrouter-live"))) {
      throw new Error(`${backend} did not stream expected stdout`);
    }
  } finally {
    await SandboxInstance.delete(name, router);
    console.log(`${backend} destroyed`);
  }
}

const raw = JSON.parse(await readFile("boxrouter.json", "utf8")) as BoxRouterConfig;
const keys = raw.keys.filter((key) => selected.includes(key.provider as (typeof selected)[number]));
const dir = await mkdtemp(path.join(tmpdir(), "boxrouter-live-"));
const router = new Router(
  { organization: raw.organization, keys },
  new JsonStore(path.join(dir, "usage.json")),
  [e2bDriver, blaxelDriver, vercelDriver],
);

const failed: string[] = [];
for (const backend of selected) {
  try {
    await smoke(backend, router);
  } catch (error) {
    failed.push(backend);
    console.error(`${backend} FAILED:`, redact(error instanceof Error ? error.stack ?? error.message : String(error)));
  }
}

if (failed.length) {
  console.error(`\nFailed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("\nAll live providers passed.");
