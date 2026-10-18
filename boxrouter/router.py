"""Round-robin selection across operator-owned provider keys."""

from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from boxrouter.errors import ConfigError, NoEligibleKey
from boxrouter.pricing import estimate_cost, get_backend_pricing, get_pricing
from boxrouter.probes import ProbeResult, check_provider
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


def _parse_time(value: str) -> datetime:
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def _create_time(item: Any) -> datetime:
    if isinstance(item, dict):
        return _parse_time(item["at"])
    return _parse_time(item)


def _start_of_day(now: datetime) -> datetime:
    return now.astimezone(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def _start_of_month(now: datetime) -> datetime:
    moment = now.astimezone(timezone.utc)
    return moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _start_of_next_month(now: datetime) -> datetime:
    moment = _start_of_month(now)
    if moment.month == 12:
        return moment.replace(year=moment.year + 1, month=1)
    return moment.replace(month=moment.month + 1)


class Router:
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
                creates = [_create_time(item) for item in usage["creates"]]
                rows.append(
                    {
                        "id": key["id"],
                        "provider": key["provider"],
                        "active": len(usage["active"]),
                        "creates_today": sum(
                            1 for item in creates if item >= _start_of_day(now)
                        ),
                        "creates_this_month": sum(
                            1 for item in creates if item >= _start_of_month(now)
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

    def organization(self) -> dict[str, Any]:
        """The single local organization. This is not a hosted account."""
        org = self._config.get("organization") or {}
        totals = self.costs()
        return {
            "name": org.get("name") or "default",
            "markup": self._markup(),
            "provider_spend_usd": totals["provider_usd"],
            "customer_spend_usd": totals["customer_usd"],
        }

    def pricing(self, provider: str | None = None) -> dict[str, Any]:
        """Bundled rate card. No network call."""
        if provider is None:
            return get_pricing()
        return get_backend_pricing(provider) or {}

    def estimate(
        self,
        provider: str,
        elapsed_secs: float,
        *,
        cpu: float = 1.0,
        memory_mb: int = 1024,
    ) -> dict[str, float]:
        """Estimate compute cost for a measured interval."""
        return estimate_cost(
            provider,
            elapsed_secs,
            cpu=cpu,
            memory_mb=memory_mb,
            markup=self._markup(),
        )

    def costs(self) -> dict[str, Any]:
        """Spend recorded when sandboxes are destroyed, from the usage file."""
        now = self._now()
        with self._store.transaction() as state:
            by_key: list[dict[str, Any]] = []
            provider_usd = 0.0
            customer_usd = 0.0
            month_provider = 0.0
            for key in self._config["keys"]:
                usage = self._usage(state, key["id"])
                key_provider = 0.0
                key_customer = 0.0
                key_month = 0.0
                for entry in usage.get("spend") or []:
                    amount = float(entry.get("provider_usd") or 0)
                    billed = float(entry.get("customer_usd") or amount)
                    key_provider += amount
                    key_customer += billed
                    if _parse_time(entry["at"]) >= _start_of_month(now):
                        key_month += amount
                provider_usd += key_provider
                customer_usd += key_customer
                month_provider += key_month
                by_key.append(
                    {
                        "id": key["id"],
                        "provider": key["provider"],
                        "provider_usd": key_provider,
                        "customer_usd": key_customer,
                        "provider_usd_this_month": key_month,
                    }
                )
            return {
                "provider_usd": provider_usd,
                "customer_usd": customer_usd,
                "provider_usd_this_month": month_provider,
                "keys": by_key,
            }

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
                    blocked_until=_start_of_day(now) + timedelta(days=1),
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
