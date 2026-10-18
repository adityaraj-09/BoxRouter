# BoxRouter

TypeScript library that replaces a Blaxel sandbox with a round-robin across the provider keys you already have. Import it in the same process. There is no BoxRouter server and no Bespoke package.

```ts
import { createRouter, SandboxInstance, settings } from "boxrouter";

const router = await createRouter("boxrouter.json");

const sandbox = await SandboxInstance.createIfNotExists(
  { name: "steer-room-agent", image: "python:3.12-slim" },
  router,
);

await sandbox.process.exec({
  name: "claude",
  command: "claude -p 'summarize the repo'",
  workingDir: "/home/user/repo",
  waitForCompletion: false,
});
sandbox.process.streamLogs("claude", {
  onStdout: (line) => console.log(line),
  onStderr: (line) => console.error(line),
});
const result = await sandbox.process.wait("claude");

const terminal = sandbox.getTerminalTarget();
// terminal.headers matches settings.headers (Authorization: Bearer …).
// terminal.url is ws://127.0.0.1:<port>/s/<name>/terminal/ws?...
```

`createRouter` installs that router as the default, so Steer's calls stay `SandboxInstance.createIfNotExists({ name, image, memory, ttl, lifecycle, region, envs, labels, externalId })`, `SandboxInstance.get(name)`, and `SandboxInstance.delete(name)`.

`get(name)` only resumes. The provider id is `provider_resource_id` in `usage.json` under the Steer sandbox name (`Sandbox.connect` on E2B, `docker inspect` on Docker, `Daytona.get` on Daytona). A missing name throws, which is what Steer's panel path already catches.

`sandbox.exec(command, { onStdout, onStderr, signal })` runs until the process exits and forwards each complete line. `process.exec` / `streamLogs` / `wait` / `kill` stay in the Blaxel shape Steer already calls, including `waitForCompletion: false`.

`sandbox.process.url` is `http://127.0.0.1:<port>/s/<name>`. Steer rewrites that to `ws` and appends `/terminal/ws`. `settings.headers` is the bearer token for that socket. `getTerminalTarget()` returns the same `{ url, headers }`.

## Providers

| Provider | Streaming command | Browser terminal |
| --- | --- | --- |
| `docker` | `docker exec` line stream | PTY via `docker exec -it`, proxied on the websocket above |
| `e2b` | `commands.run({ onStdout, onStderr })` | E2B PTY proxied on the same websocket. `npm install e2b` |
| `daytona` | SDK `executeCommand`, lines delivered when the command returns | No provider PTY. The websocket closes with an explanation. `npm install @daytonaio/sdk` |

Modal is not included. It has no TypeScript sandbox SDK to vendor.

## Config

`examples/config.example.json`:

```json
{
  "organization": { "name": "default", "markup": 1 },
  "keys": [
    {
      "id": "e2b-a",
      "provider": "e2b",
      "credentials": { "E2B_API_KEY": "e2b_..." },
      "limits": { "concurrent_sandboxes": 20, "creates_per_day": 200, "spend_usd_per_month": 30 }
    }
  ]
}
```

`router.pricing("e2b")`, `router.estimate(...)`, `router.organization()`, and `router.costs()` are local function calls. Rates live in `src/pricing.json`. Destroying a sandbox writes the estimate into `usage.json`. A key over `spend_usd_per_month` is skipped until the next UTC month.

## Swap inside Steer

Replace the `@blaxel/core` import with `boxrouter` and call `createRouter` once at startup. Keep `cliSandbox.ts` (clone, Claude/Codex, commit, push, pull request). `execInSandbox` already uses `process.exec`, `streamLogs`, `wait`, and `kill`. The panel builds the terminal URL from `process.url` plus `/terminal/ws` and copies `settings.headers`. Pass the same sandbox `name` you stored as `sdk_agent_id`.

Docker and E2B attach a PTY on that websocket. Daytona has no PTY, so the socket closes with an explanation. Modal has no TypeScript sandbox client, so it is not a driver in this package.
