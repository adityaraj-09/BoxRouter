# BoxRouter

In-process TypeScript router for agent sandboxes. One `SandboxInstance` API, many provider keys. New sandboxes round-robin across the keys you configure. The same name always reconnects to the sandbox that was already created.

BoxRouter runs inside your process. Import it, point it at a JSON config, and drive sandboxes through one `SandboxInstance` API.

```ts
import { createRouter, SandboxInstance, settings } from "sandbox-router";

const router = await createRouter("boxrouter.json");

const sandbox = await SandboxInstance.createIfNotExists({
  name: "room-agent",
  image: "python:3.12-slim",
});

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
// terminal.url    ws://127.0.0.1:<port>/s/<name>/terminal/ws?...
// terminal.headers === settings.headers   Authorization: Bearer …
```

`createRouter` installs that router as the process default, so later calls can omit the router argument.

## Install

Requires Node.js 20 or newer.

```bash
npm install sandbox-router
```

Provider SDKs are optional peers. Install only the ones whose keys you put in config:

```bash
npm install e2b @blaxel/core @vercel/sandbox @daytonaio/sdk modal @namespacelabs/sdk @tensorlakeai/tensorlake @boatdev/sdk freestyle
```

Docker uses the local `docker` CLI. Isorun and Cloudflare talk HTTP and need no extra package.

## Routing

Every sandbox is stored under the `name` you pass to `createIfNotExists`.

| Call | What happens |
| --- | --- |
| New name | Next eligible key is chosen, a sandbox is created, and the provider resource id is saved. |
| Same name again | That sandbox is resumed. Nothing new is created. |
| `SandboxInstance.get(name)` | Resume only. An unknown name throws. |
| `SandboxInstance.delete(name)` | The provider sandbox is destroyed and a local cost estimate is recorded. |
| `backend: "e2b"` | Rotation stays inside keys whose `provider` is `e2b`. |

Selection walks `keys` from a saved cursor and skips a key that is invalid, blocked, or over a limit. After a successful pick the cursor advances, so the next new name lands on the following key.

Failover:

- **401 / 403 / invalid API key.** The key is marked invalid and the next key is tried.
- **Quota, rate limit, or billing.** The key is blocked until the end of the UTC day, then the next key is tried.
- **Any other create error.** The attempt is rolled back and the error is thrown.

State is a JSON file next to the config (`usage.json` when the config is `boxrouter.json`). It stores names, resource ids, the cursor, and spend. Credentials are not written there.

## Configuration

Copy `examples/config.example.json` to `boxrouter.json` and keep that file out of git.

```json
{
  "organization": { "name": "default", "markup": 1 },
  "keys": [
    {
      "id": "e2b-a",
      "provider": "e2b",
      "credentials": { "E2B_API_KEY": "e2b_..." },
      "limits": {
        "concurrent_sandboxes": 20,
        "creates_per_day": 200,
        "creates_per_month": 2000,
        "spend_usd_per_month": 30
      }
    },
    {
      "id": "blaxel-a",
      "provider": "blaxel",
      "credentials": {
        "BL_API_KEY": "bl_...",
        "BL_WORKSPACE": "your-workspace"
      },
      "limits": { "concurrent_sandboxes": 10, "creates_per_day": 100 }
    }
  ]
}
```

`organization.markup` multiplies the provider estimate into a customer figure. `1` means they match.

| Limit | Effect |
| --- | --- |
| `concurrent_sandboxes` | Skip the key while that many names are still active. |
| `creates_per_day` | Skip until the next UTC day. |
| `creates_per_month` | Skip until the next UTC month. |
| `spend_usd_per_month` | Skip until the next UTC month. `monthly_spend_usd` is the same cap. |

Only keys that can actually create should sit in `keys`. A placeholder credential is selected like any other key and fails at create time.

## Providers

Each driver implements the same three calls: reconnect by the stored id, stream command output as it is produced, and attach a browser terminal. The terminal BoxRouter returns is always a local WebSocket plus `settings.headers`. Vendor PTY sessions are proxied onto that socket. Boat is the exception: its HTTP API exposes SSH and a desktop, not an attachable PTY, so it reports `terminal: false`.

| `provider` | Package | Credentials | Notes |
| --- | --- | --- | --- |
| `docker` | local `docker` | none | `docker exec` stream and an interactive `docker exec -it` PTY. |
| `e2b` | `e2b` | `E2B_API_KEY` | `Sandbox.connect`, `commands.run` callbacks, E2B PTY. |
| `daytona` | `@daytonaio/sdk` | `DAYTONA_API_KEY`, optional `DAYTONA_API_URL` | Session logs stream while the command runs. PTY via `createPty`. |
| `blaxel` | `@blaxel/core` | `BL_API_KEY`, `BL_WORKSPACE`, optional `BL_REGION` | Named sandbox. Logs via `streamLogs`. Region defaults to `us-pdx-1`. The API key needs a role on that workspace. |
| `isorun` | none | `ISORUN_API_KEY`, optional `ISORUN_API_URL` | SSE `POST /exec/stream`. Terminal is `GET /terminal?token=…`. Default API host is `https://run-us.isorun.ai`. |
| `tensorlake` | `@tensorlakeai/tensorlake` | `TENSORLAKE_API_KEY` | `Sandbox.connect`, `followOutput`, `createPty`. |
| `modal` | `modal` | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, optional `MODAL_APP` | `fromId` reconnect. Exec streams stdout and stderr. Terminal is a PTY exec piped locally. Default app name is `boxrouter`. |
| `vercel` | `@vercel/sandbox` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | `Sandbox.get({ name })`. Detached `runCommand` logs. Terminal is a bash session with stdin. |
| `cloudflare` | none | `CLOUDFLARE_SANDBOX_URL`, `CLOUDFLARE_SANDBOX_API_KEY` | Your deployed [sandbox bridge](https://developers.cloudflare.com/sandbox/bridge/) Worker. Exec is SSE. Terminal is `GET /v1/sandbox/:id/pty`. |
| `namespace` | `@namespacelabs/sdk` | `NSC_TOKEN` or `NAMESPACE_TOKEN`, optional `NSC_DEVBOX_ENDPOINT` | `devboxes.get`. Exec callbacks. `terminal.open()` starts a new PTY on each attach; Namespace does not keep that session for reattach. |
| `boat` | `@boatdev/sdk` | `BOAT_API_KEY`, optional `BOAT_API_URL` | `create`, `get`, `resume`, `streamCommand`. `image` is passed as `from`, so it must be a saved Boat snapshot name; Docker image names are not supported. Size comes from `cpu`/`memory`: small (2 vCPU/4 GiB), default (4/8), large (8/16), xlarge (16/32). Commands cap at 600 s. Boat's HTTP API has no attachable PTY, so `terminal` is `false`. |
| `freestyle` | `freestyle` | `FREESTYLE_API_KEY`, optional `FREESTYLE_API_URL` | `vms.create` with a public firewall, `vms.get` + `start` on resume, `vm.exec`, `vm.pty.open`. `image` is treated as a Freestyle snapshot id and `cpu`/`memory` grow the VM (Freestyle cannot shrink). Create-time `env` is not supported; pass `env` per exec. Exec has no live callbacks, so output is emitted once the command finishes and caps at 300 s. The PTY closes when the terminal socket closes. |

Pin one vendor when you do not want rotation:

```ts
await SandboxInstance.createIfNotExists({
  name: "room-agent",
  backend: "blaxel",
});
```

## API

`SandboxInstance` is the call surface: create, exec, stream logs, list files, and open a terminal.

| Method | Behavior |
| --- | --- |
| `createIfNotExists(opts)` | Open or resume by `name`. Accepts `image`, `memory`, `ttl`, `lifecycle`, `region`, `envs`, `labels`, `externalId`, `backend`. `ttl` and `lifecycle` are stored for type compatibility and are not enforced. |
| `get(name)` | Resume. Throws when the name is unknown. |
| `delete(name)` / `sandbox.delete()` | Destroy and bill the local estimate. |
| `list({ labels })` | Names recorded locally, filtered by labels stored at create. |
| `process.exec({ name, command, workingDir, env, timeout, waitForCompletion })` | Start a named command. `timeout` is seconds. `waitForCompletion: false` returns after start. |
| `process.streamLogs(name, { onStdout, onStderr })` | Replay buffered lines, then live lines. `close()` drops the subscriber. |
| `process.wait(name, { maxWait, signal })` | Resolve with `{ exitCode, stdout, stderr, status }`. |
| `process.kill(name)` / `process.stop(name)` | Cancel the command. |
| `process.get(name)` | `{ status: "running" \| "completed" \| "unknown" }`. |
| `fs.ls(dir)` | `{ subdirectories, files }`. |
| `sandbox.exec(command, { onStdout, onStderr, cwd, env, signal, timeoutMs })` | Run to completion and emit complete lines. |
| `getTerminalTarget()` | `{ url, headers }` for the local PTY websocket. |
| `process.url` | `http://127.0.0.1:<port>/s/<name>`. |
| `unarchive()` | No-op. |

`settings.headers` is the bearer token for that websocket. Open `process.url` with the scheme rewritten to `ws` and `/terminal/ws` appended, and send `settings.headers` on the upgrade.

Router helpers:

```ts
await router.status();
await router.organization();
await router.costs();
router.pricing("e2b");
router.estimate("e2b", elapsedSeconds, cpu, memoryMb);
```

Rates live in `src/pricing.json` and are estimates. Destroy writes `provider_usd` and `customer_usd` (estimate × markup) into `usage.json`.

## Startup

Call `createRouter` once when the process starts. Later `SandboxInstance` calls use that router.

```ts
import { createRouter } from "sandbox-router";

await createRouter(process.env.BOXROUTER_CONFIG ?? "boxrouter.json");
```

Keep the sandbox `name` you want to resume. `get(name)` throws when that name was never created.

## Develop

```bash
npm install
npm test
npm run build
```

`npm test` covers rotation, reconnect, line streaming, the terminal websocket, and spend caps with an in-memory driver.

To exercise real keys, put them in `boxrouter.json` and run:

```bash
npx tsx scripts/live-smoke.mts e2b blaxel vercel
npx tsx scripts/live-roundrobin.mts
```

The smoke script creates a sandbox, streams a command, reconnects by name, lists `/`, and deletes it. The round-robin script opens one sandbox per configured key in `e2b`, `blaxel`, and `vercel` and checks that successive names land on different providers.

## License

Apache-2.0
