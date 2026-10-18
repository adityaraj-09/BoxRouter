"""Local organization, rate card, and spend ledger.

These are in-process function calls. They do not start a server and they
do not call the Bespoke control plane.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from boxrouter.pricing import estimate_cost, get_backend_pricing, get_pricing
from boxrouter.router_time import parse_time, start_of_month


class BillingMixin:
    """Pricing and organization methods mixed into Router."""

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
                    if parse_time(entry["at"]) >= start_of_month(now):
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

    def _markup(self) -> float:
        org = self._config.get("organization") or {}
        try:
            return float(org.get("markup", 1.0))
        except (TypeError, ValueError):
            return 1.0

    def _spend_this_month(self, usage: dict[str, Any], now: datetime) -> float:
        total = 0.0
        for entry in usage.get("spend") or []:
            if parse_time(entry["at"]) >= start_of_month(now):
                total += float(entry.get("provider_usd") or 0)
        return total

    def _accrue(
        self, state: dict[str, Any], record: dict[str, Any], sandbox_id: str
    ) -> None:
        usage = self._usage(state, record["key_id"])
        if any(
            isinstance(entry, dict) and entry.get("sandbox_id") == sandbox_id
            for entry in usage.get("spend") or []
        ):
            return
        created = parse_time(record["created_at"])
        elapsed = max(0.0, (self._now() - created).total_seconds())
        amounts = estimate_cost(
            record["provider"],
            elapsed,
            cpu=float(record.get("cpu") or 1.0),
            memory_mb=int(record.get("memory_mb") or 1024),
            markup=self._markup(),
        )
        usage.setdefault("spend", []).append(
            {
                "at": self._now().isoformat(),
                "sandbox_id": sandbox_id,
                "provider_usd": amounts["provider_usd"],
                "customer_usd": amounts["customer_usd"],
                "seconds": elapsed,
            }
        )
