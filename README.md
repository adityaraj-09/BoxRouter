# BoxRouter

Operator-hosted gateway that creates sandboxes across multiple providers from one API.

You hold the provider keys (E2B, Modal, Daytona, and others). Callers do not sign up or bring their own keys. A create request is sent to the next eligible key in round-robin order. Keys that are over their concurrency, daily, or monthly limit are marked exhausted and skipped until that window renews.

Asking for a specific backend still uses that provider's full sandbox capabilities (execute, files, presets, and the rest of what that provider supports).

This repository is a starting point. Implementation has not landed yet.
