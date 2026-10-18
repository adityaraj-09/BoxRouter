"""Local compute-price estimates.

Rates come from a JSON file shipped with this package. Nothing is fetched
from a BoxRouter or Bespoke server.
"""

from __future__ import annotations

import functools
import json
from pathlib import Path

_PRICING_PATH = Path(__file__).parent / "pricing.json"


@functools.cache
def get_pricing() -> dict:
    """Return the full pricing table."""
    with _PRICING_PATH.open(encoding="utf-8") as pricing_file:
        return json.load(pricing_file)


def get_backend_pricing(provider: str) -> dict | None:
    """Return one provider's rates, or None when the table has no entry."""
    return get_pricing()["backends"].get(provider)


def cost_per_second(provider: str, vcpu: float = 1.0, ram_gib: float = 1.0) -> float:
    """Estimated dollars per second at the given vCPU and RAM."""
    info = get_backend_pricing(provider)
    if info is None:
        return 0.0
    vcpu_per_sec = info.get("vcpu_per_hour_usd", 0.0) / 3600
    ram_per_sec = info.get("ram_gib_per_hour_usd", 0.0) / 3600
    return vcpu_per_sec * vcpu + ram_per_sec * ram_gib


def estimate_cost(
    provider: str,
    elapsed_secs: float,
    *,
    cpu: float = 1.0,
    memory_mb: int = 1024,
    markup: float = 1.0,
) -> dict[str, float]:
    """Provider estimate and the same amount after the organization markup."""
    ram_gib = memory_mb / 1024
    provider_usd = cost_per_second(provider, cpu, ram_gib) * max(0.0, elapsed_secs)
    return {
        "provider_usd": provider_usd,
        "customer_usd": provider_usd * markup,
    }
