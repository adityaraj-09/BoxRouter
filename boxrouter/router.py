"""Round-robin selection across operator-owned provider keys."""

from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from boxrouter.billing import BillingMixin
from boxrouter.errors import ConfigError, NoEligibleKey
from boxrouter.probes import ProbeResult, check_provider
from boxrouter.router_time import (
    create_time,
    end_of_day,
    parse_time,
    start_of_day,
    start_of_month,
    start_of_next_month,
)
from boxrouter.session import RoutedSandbox
from boxrouter.store import JsonStore

_QUOTA_HINTS = (
    "quota",
    "rate limit",
    "too many requests",
    "429",
    "insufficient",
    "credit",
    "billing",
    "limit exceeded",
    "exceeded",
)
_AUTH_HINTS = (
    "401",
    "403",
    "unauthenticated",
    "unauthorized",
    "invalid api key",
    "invalid_api_key",
    "authentication failed",
)


class Router(BillingMixin):
    """Create sandboxes by walking provider keys in round-robin order.

    Usage is stored in a JSON file. There is no background sweeper: daily and
    monthly windows are applied the next time ``create`` runs, and a sandbox
    frees its concurrency slot when ``destroy`` is called.
    """

    def __init__(
        self,
        config: dict[str, Any] | str | Path,
        *,
        state_path: str | Path | None = None,
        sandbox_factory: Callable[..., Any] | None = None,
        probe: Callable[[dict[str, Any]], ProbeResult] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if isinstance(config, (str, Path)):
            path = Path(config)
            self._config = json.loads(path.read_text(encoding="utf-8"))
            default_state = path.with_name("usage.json")
        else:
            self._config = config
            default_state = Path("usage.json")
        keys = self._config.get("keys")
        if not isinstance(keys, list) or not keys:
            raise ConfigError("config.keys must be a non-empty list")
        seen: set[str] = set()
        for key in keys:
            if "id" not in key or "provider" not in key:
                raise ConfigError("each key needs id and provider")
            if key["id"] in seen:
                raise ConfigError(f"duplicate key id {key['id']}")
            seen.add(key["id"])
            key.setdefault("credentials", {})
            key.setdefault("limits", {})
        self._state_path = Path(state_path) if state_path else default_state
        self._store = JsonStore(self._state_path)
        self._factory = sandbox_factory or _default_factory
        self._probe = probe or check_provider
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._env_lock = threading.Lock()

    @classmethod
    def from_file(
        cls,
        path: str | Path,
        *,
        state_path: str | Path | None = None,
        **kwargs: Any,
    ) -> Router:
        return cls(path, state_path=state_path, **kwargs)

    def close(self) -> None:
        self._store.close()

    @contextmanager
    def credentials(self, key: dict[str, Any]) -> Iterator[None]:
        """Set this key's environment variables for one provider call."""
        creds = {
            name: str(value)
            for name, value in (key.get("credentials") or {}).items()
            if isinstance(value, str)
        }
        with self._env_lock:
            previous = {name: os.environ.get(name) for name in creds}
            os.environ.update(creds)
            try:
                yield
            finally:
                for name, old in previous.items():
                    if old is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = old

    def status(self) -> list[dict[str, Any]]:
        """Per-key usage. Secrets are not included."""
        now = self._now()
        with self._store.transaction() as state:
            rows = []
            for key in self._config["keys"]:
                usage = self._usage(state, key["id"])
                creates = [create_time(item) for item in usage["creates"]]
                rows.append(
                    {
                        "id": key["id"],
                        "provider": key["provider"],
                        "active": len(usage["active"]),
                        "creates_today": sum(
                            1 for item in creates if item >= start_of_day(now)
                        ),
                        "creates_this_month": sum(
                            1 for item in creates if item >= start_of_month(now)
                        ),
                        "invalid": bool(usage.get("invalid")),
                        "blocked_until": usage.get("blocked_until"),
                        "blocked_reason": usage.get("blocked_reason"),
                        "last_probe": usage.get("last_probe"),
                        "limits": key.get("limits") or {},
                        "spend_usd_this_month": self._spend_this_month(usage, now),
                    }
                )
            return rows

    def forget(self, sandbox_id: str) -> None:
        """Drop a sandbox from the usage file without calling the provider."""
        with self._store.transaction() as state:
            self._drop(state, sandbox_id)

    def release(self, sandbox_id: str) -> None:
        """Free the concurrency slot after the provider sandbox is gone."""
        self.forget(sandbox_id)

    def create(self, backend: str | None = None, **sandbox_kwargs: Any) -> RoutedSandbox:
        """Create a sandbox on the next eligible key.

        ``backend`` limits the ring to one provider (``"e2b"``, ``"modal"``,
        ...). Every other keyword is passed to ``bespokelabs.sandbox.Sandbox``.
        """
        now = self._now()
        with self._store.transaction() as state:
            chosen, sandbox_id = self._reserve(state, backend, now, sandbox_kwargs)
        key = chosen
        try:
            with self.credentials(key):
                sandbox = self._factory(key["provider"], **sandbox_kwargs)
        except Exception as exc:
            self._rollback(sandbox_id)
            if _is_auth(exc):
                self._mark(key["id"], invalid=True, reason=str(exc)[:300])
            elif _is_quota(exc):
                self._mark(
                    key["id"],
                    blocked_until=end_of_day(now),
                    reason=str(exc)[:300],
                )
            else:
                raise
            return self._create_after_failure(backend, sandbox_kwargs, skip={key["id"]})
        resource_id = getattr(sandbox, "provider_resource_id", None)
        with self._store.transaction() as state:
            record = state["sandboxes"].get(sandbox_id)
            if record is not None and resource_id is not None:
                record["provider_resource_id"] = str(resource_id)
        return RoutedSandbox(sandbox_id, key, sandbox, self)

    def _create_after_failure(
        self,
        backend: str | None,
        sandbox_kwargs: dict[str, Any],
        skip: set[str],
    ) -> RoutedSandbox:
        """Try the remaining keys once. The first non-quota error is raised."""
        now = self._now()
        while True:
            with self._store.transaction() as state:
                try:
                    key, sandbox_id = self._reserve(
                        state, backend, now, sandbox_kwargs, skip=skip
                    )
                except NoEligibleKey:
                    raise
            try:
                with self.credentials(key):
                    sandbox = self._factory(key["provider"], **sandbox_kwargs)
            except Exception as exc:
                self._rollback(sandbox_id)
                skip.add(key["id"])
                if _is_auth(exc):
                    self._mark(key["id"], invalid=True, reason=str(exc)[:300])
                    continue
                if _is_quota(exc):
                    self._mark(
                        key["id"],
                        blocked_until=end_of_day(now),
                        reason=str(exc)[:300],
                    )
                    continue
                raise
            resource_id = getattr(sandbox, "provider_resource_id", None)
            with self._store.transaction() as state:
                record = state["sandboxes"].get(sandbox_id)
                if record is not None and resource_id is not None:
                    record["provider_resource_id"] = str(resource_id)
            return RoutedSandbox(sandbox_id, key, sandbox, self)

    def _reserve(
        self,
        state: dict[str, Any],
        backend: str | None,
        now: datetime,
        resources: dict[str, Any] | None = None,
        skip: set[str] | None = None,
    ) -> tuple[dict[str, Any], str]:
        keys: list[dict[str, Any]] = self._config["keys"]
        skipped = skip or set()
        cursor = int(state.get("cursor") or 0) % len(keys)
        considered = 0
        for offset in range(len(keys)):
            index = (cursor + offset) % len(keys)
            key = keys[index]
            if backend and key["provider"] != backend:
                continue
            if key["id"] in skipped:
                continue
            considered += 1
            reason = self._local_block(state, key, now)
            if reason:
                continue
            probe = self._probe(key)
            usage = self._usage(state, key["id"])
            usage["last_probe"] = {
                "at": now.isoformat(),
                "exhausted": probe.exhausted,
                "reason": probe.reason,
                "detail": probe.detail,
            }
            if probe.auth_failed:
                usage["invalid"] = True
                usage["blocked_reason"] = probe.reason
                continue
            if probe.exhausted:
                if probe.persist and probe.until is not None:
                    usage["blocked_until"] = probe.until.isoformat()
                    usage["blocked_reason"] = probe.reason
                continue
            state["cursor"] = (index + 1) % len(keys)
            sandbox_id = uuid.uuid4().hex
            usage["creates"].append(
                {"at": now.isoformat(), "sandbox_id": sandbox_id}
            )
            usage["active"].append(sandbox_id)
            shape = resources or {}
            state["sandboxes"][sandbox_id] = {
                "key_id": key["id"],
                "provider": key["provider"],
                "created_at": now.isoformat(),
                "provider_resource_id": None,
                "cpu": float(shape.get("cpu") or 1.0),
                "memory_mb": int(shape.get("memory_mb") or 1024),
            }
            return key, sandbox_id
        if considered == 0:
            raise NoEligibleKey(
                f"no keys configured for backend {backend!r}"
                if backend
                else "no keys configured"
            )
        raise NoEligibleKey("every provider key is exhausted or invalid")

    def _local_block(
        self, state: dict[str, Any], key: dict[str, Any], now: datetime
    ) -> str | None:
        usage = self._usage(state, key["id"])
        if usage.get("invalid"):
            return "invalid"
        blocked = usage.get("blocked_until")
        if blocked:
            if parse_time(blocked) > now:
                return usage.get("blocked_reason") or "blocked"
            usage["blocked_until"] = None
            usage["blocked_reason"] = None
        limits = key.get("limits") or {}
        usage["creates"] = [
            item
            for item in usage["creates"]
            if create_time(item) >= start_of_month(now)
        ]
        creates = [create_time(item) for item in usage["creates"]]
        concurrent = limits.get("concurrent_sandboxes")
        if concurrent is not None and len(usage["active"]) >= int(concurrent):
            return "concurrent_sandboxes"
        per_day = limits.get("creates_per_day")
        if per_day is not None:
            today = [item for item in creates if item >= start_of_day(now)]
            if len(today) >= int(per_day):
                usage["blocked_until"] = end_of_day(now).isoformat()
                usage["blocked_reason"] = "creates_per_day"
                return "creates_per_day"
        per_month = limits.get("creates_per_month")
        if per_month is not None and len(creates) >= int(per_month):
            usage["blocked_until"] = start_of_next_month(now).isoformat()
            usage["blocked_reason"] = "creates_per_month"
            return "creates_per_month"
        spend_cap = limits.get("spend_usd_per_month")
        if spend_cap is None:
            spend_cap = limits.get("monthly_spend_usd")
        if spend_cap is not None and self._spend_this_month(usage, now) >= float(spend_cap):
            usage["blocked_until"] = start_of_next_month(now).isoformat()
            usage["blocked_reason"] = "spend_usd_per_month"
            return "spend_usd_per_month"
        return None

    def _usage(self, state: dict[str, Any], key_id: str) -> dict[str, Any]:
        keys = state.setdefault("keys", {})
        usage = keys.setdefault(
            key_id,
            {
                "creates": [],
                "active": [],
                "invalid": False,
                "blocked_until": None,
                "blocked_reason": None,
                "last_probe": None,
            },
        )
        return usage

    def _drop(self, state: dict[str, Any], sandbox_id: str, *, bill: bool = True) -> None:
        record = state.get("sandboxes", {}).pop(sandbox_id, None)
        if record is None:
            return
        if bill:
            self._accrue(state, record, sandbox_id)
        usage = state.get("keys", {}).get(record["key_id"])
        if usage is None:
            return
        usage["active"] = [
            item for item in usage.get("active", []) if item != sandbox_id
        ]
        usage["creates"] = [
            item
            for item in usage.get("creates", [])
            if not (isinstance(item, dict) and item.get("sandbox_id") == sandbox_id)
        ]

    def _rollback(self, sandbox_id: str) -> None:
        with self._store.transaction() as state:
            self._drop(state, sandbox_id, bill=False)

    def _mark(
        self,
        key_id: str,
        *,
        invalid: bool = False,
        blocked_until: datetime | None = None,
        reason: str = "",
    ) -> None:
        with self._store.transaction() as state:
            usage = self._usage(state, key_id)
            if invalid:
                usage["invalid"] = True
            if blocked_until is not None:
                usage["blocked_until"] = blocked_until.isoformat()
            if reason:
                usage["blocked_reason"] = reason


def _default_factory(backend: str, **kwargs: Any) -> Any:
    from bespokelabs.sandbox import Sandbox

    return Sandbox(backend, **kwargs)


def _is_quota(exc: BaseException) -> bool:
    text = str(exc).lower()
    return any(hint in text for hint in _QUOTA_HINTS)


def _is_auth(exc: BaseException) -> bool:
    text = str(exc).lower()
    return any(hint in text for hint in _AUTH_HINTS)
