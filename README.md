# BoxRouter

One Python interface for sandboxes on E2B, Modal, Daytona, RunPod, and the other backends supported by [bespokelabs-sandbox](https://github.com/bespokelabsai/sandbox). You keep the provider keys. Each `create()` walks those keys in round-robin order and skips a key that is over its limit.

There is no HTTP API and no user signup. Call `Router` from your own code.

## Install

```bash
pip install -e .
# plus the provider you actually call, for example:
pip install -e '.[e2b]'
```

## Configure keys

Copy `examples/config.example.json` and fill in your keys. Limits are optional.

| Limit | Effect |
| --- | --- |
| `concurrent_sandboxes` | Skip the key while this many sandboxes from it are still open |
| `creates_per_day` | Block the key until the next UTC day |
| `creates_per_month` | Block the key until the next UTC month |
| `monthly_spend_usd` | Modal only. Compared with `Workspace.billing.summary()` |

Usage, the round-robin cursor, and open sandbox ids are written to `usage.json` next to the config file. Secrets stay in the config file and are not copied into the usage file.

## Create a sandbox

```python
from boxrouter import Router

router = Router.from_file("config.json")

with router.create(timeout_secs=600) as sandbox:
    print(sandbox.provider, sandbox.key_id)
    result = sandbox.execute_code('print("hello")')
    print(result.stdout)
    sandbox.write_file("/tmp/note.txt", "hello")

# Force one provider. Keys for that provider still rotate.
with router.create(backend="e2b", template="base") as sandbox:
    sandbox.execute_command("uname", ["-a"])

print(router.status())
```

`sandbox` forwards to a bespokelabs `Sandbox`, so code execution, commands, files, presets, workspaces, agents, and snapshots work the same way as that SDK. The provider's own extra must be installed (`e2b`, `modal`, `daytona`, ...).

`router.create(backend="e2b")` still round-robins the E2B keys you configured. Omit `backend` to rotate across every provider.

## How a key is skipped

On each create, starting at the next key in the ring:

1. Local counts in `usage.json` (open sandboxes, creates today, creates this month).
2. A live provider check:
   - **E2B** — `GET https://api.e2b.app/v2/sandboxes` and the `X-Total-Running` header.
   - **Daytona** — `GET /organizations/{id}/usage` (organization id from config, or the first org returned by the API).
   - **Modal** — billing summary when `monthly_spend_usd` is set and the Modal SDK is installed.
   - **RunPod** — `GET https://rest.runpod.io/v1/pods`.
3. If the provider create then fails with a quota or auth error, that key is marked and the next key is tried.

A full concurrency or CPU quota skips the key for that attempt only, so a later destroy can make it eligible again. A daily or monthly counter, HTTP 429, or Modal spend cap is stored as `blocked_until`. An auth failure marks the key `invalid` until you change the config and delete that flag from `usage.json`.

Destroying a sandbox (or leaving a `with` block) removes its concurrency slot. If a process dies first, call `router.forget(sandbox_id)` to drop the slot without calling the provider. There is no background cleanup.

## What this version leaves out

No accounts, no per-caller quotas, no HTTP server, and no sweeper that kills sandboxes when a process exits. Provider limits that are not in the config, and not returned by the probes above, are enforced only when the provider itself rejects the create.
