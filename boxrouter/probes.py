"""Live usage checks against provider HTTP APIs.

A failed network call does not mark a key exhausted. Authentication
failures and HTTP 429 do. Concurrency reported by the provider skips
the key for this create only; a hard quota or rate limit is remembered
until the end of the UTC day (or the next month for Modal spend).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

Opener = Callable[..., Any]


@dataclass
class ProbeResult:
    exhausted: bool = False
    auth_failed: bool = False
    persist: bool = False
    reason: str = ""
    until: datetime | None = None
    detail: str = ""


def check_provider(
    key: dict[str, Any],
    *,
    opener: Opener = urlopen,
    now: datetime | None = None,
) -> ProbeResult:
    """Ask the provider whether this key can take another sandbox."""
    moment = now or datetime.now(timezone.utc)
    provider = key["provider"]
    limits = key.get("limits") or {}
    credentials = key.get("credentials") or {}
    try:
        if provider == "e2b":
            return _probe_e2b(credentials, limits, opener, moment)
        if provider == "daytona":
            return _probe_daytona(key, limits, opener, moment)
        if provider == "modal":
            return _probe_modal(limits, moment)
        if provider == "runpod":
            return _probe_runpod(credentials, limits, opener, moment)
    except HTTPError as exc:
        return _from_http_error(exc, moment)
    except URLError as exc:
        return ProbeResult(detail=f"probe unreachable: {exc.reason}")
    except Exception as exc:  # modal SDK and unexpected payload shapes
        return ProbeResult(detail=f"probe skipped: {exc}")
    return ProbeResult(detail="no live probe for this provider")


def _from_http_error(exc: HTTPError, now: datetime) -> ProbeResult:
    if exc.code in {401, 403}:
        return ProbeResult(auth_failed=True, reason=f"provider auth failed ({exc.code})")
    if exc.code == 429:
        return ProbeResult(
            exhausted=True,
            persist=True,
            reason="provider rate limit",
            until=_end_of_utc_day(now),
        )
    return ProbeResult(detail=f"probe http {exc.code}")


def _probe_e2b(
    credentials: dict[str, str],
    limits: dict[str, Any],
    opener: Opener,
    now: datetime,
) -> ProbeResult:
    api_key = credentials.get("E2B_API_KEY")
    if not api_key:
        return ProbeResult(auth_failed=True, reason="E2B_API_KEY missing")
    status, headers, _body = _get(
        "https://api.e2b.app/v2/sandboxes?limit=1",
        {"X-API-Key": api_key, "Accept": "application/json"},
        opener,
    )
    if status in {401, 403}:
        return ProbeResult(auth_failed=True, reason=f"e2b auth failed ({status})")
    if status == 429:
        return ProbeResult(
            exhausted=True,
            persist=True,
            reason="e2b rate limit",
            until=_end_of_utc_day(now),
        )
    cap = limits.get("concurrent_sandboxes")
    running = headers.get("X-Total-Running") or headers.get("x-total-running")
    if cap is not None and running not in (None, ""):
        if int(running) >= int(cap):
            return ProbeResult(
                exhausted=True,
                reason="e2b concurrent sandboxes",
            )
    return ProbeResult(detail="e2b ok")


def _probe_daytona(
    key: dict[str, Any],
    limits: dict[str, Any],
    opener: Opener,
    now: datetime,
) -> ProbeResult:
    del limits
    credentials = key.get("credentials") or {}
    api_key = credentials.get("DAYTONA_API_KEY")
    if not api_key:
        return ProbeResult(auth_failed=True, reason="DAYTONA_API_KEY missing")
    base = credentials.get("DAYTONA_API_URL", "https://app.daytona.io/api").rstrip("/")
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    org_id = key.get("organization_id") or credentials.get("DAYTONA_ORGANIZATION_ID")
    if not org_id:
        status, _headers, body = _get(f"{base}/organizations", headers, opener)
        if status in {401, 403}:
            return ProbeResult(auth_failed=True, reason=f"daytona auth failed ({status})")
        if status == 429:
            return ProbeResult(
                exhausted=True,
                persist=True,
                reason="daytona rate limit",
                until=_end_of_utc_day(now),
            )
        orgs = _as_list(body)
        if not orgs:
            return ProbeResult(detail="daytona returned no organization")
        org_id = orgs[0].get("id") or orgs[0].get("organizationId")
    status, _headers, body = _get(
        f"{base}/organizations/{org_id}/usage", headers, opener
    )
    if status in {401, 403}:
        return ProbeResult(auth_failed=True, reason=f"daytona auth failed ({status})")
    if status == 429:
        return ProbeResult(
            exhausted=True,
            persist=True,
            reason="daytona rate limit",
            until=_end_of_utc_day(now),
        )
    regions = body.get("regionUsage") if isinstance(body, dict) else None
    if not regions:
        return ProbeResult(detail="daytona ok")
    capped = [
        region
        for region in regions
        if region.get("totalCpuQuota") not in (None, 0)
    ]
    if capped and all(
        float(region.get("currentCpuUsage") or 0) >= float(region["totalCpuQuota"])
        for region in capped
    ):
        return ProbeResult(exhausted=True, reason="daytona cpu quota")
    return ProbeResult(detail="daytona ok")


def _probe_modal(limits: dict[str, Any], now: datetime) -> ProbeResult:
    cap = limits.get("monthly_spend_usd")
    if cap is None:
        return ProbeResult(detail="modal spend cap not configured")
    import modal  # type: ignore

    workspace = modal.Workspace.from_context()
    summary = workspace.billing.summary()
    cost = getattr(summary, "billed_cost", None)
    if cost is None:
        cost = getattr(summary, "metered_cost", None)
    if cost is None:
        return ProbeResult(detail="modal summary has no cost")
    if float(cost) >= float(cap):
        return ProbeResult(
            exhausted=True,
            persist=True,
            reason="modal monthly spend",
            until=_start_of_next_month(now),
        )
    return ProbeResult(detail="modal ok")


def _probe_runpod(
    credentials: dict[str, str],
    limits: dict[str, Any],
    opener: Opener,
    now: datetime,
) -> ProbeResult:
    api_key = credentials.get("RUNPOD_API_KEY")
    if not api_key:
        return ProbeResult(auth_failed=True, reason="RUNPOD_API_KEY missing")
    status, _headers, body = _get(
        "https://rest.runpod.io/v1/pods",
        {"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
        opener,
    )
    if status in {401, 403}:
        return ProbeResult(auth_failed=True, reason=f"runpod auth failed ({status})")
    if status == 429:
        return ProbeResult(
            exhausted=True,
            persist=True,
            reason="runpod rate limit",
            until=_end_of_utc_day(now),
        )
    cap = limits.get("concurrent_sandboxes")
    pods = _as_list(body)
    if cap is not None and len(pods) >= int(cap):
        return ProbeResult(exhausted=True, reason="runpod concurrent pods")
    return ProbeResult(detail="runpod ok")


def _get(
    url: str, headers: dict[str, str], opener: Opener
) -> tuple[int, dict[str, str], Any]:
    request = Request(url, headers=headers, method="GET")
    try:
        response = opener(request, timeout=20)
    except HTTPError as exc:
        response = exc
    with response:
        payload = response.read()
        parsed: Any = {}
        if payload:
            try:
                parsed = json.loads(payload.decode())
            except json.JSONDecodeError:
                parsed = {}
        header_map = {key: value for key, value in response.headers.items()}
        status = getattr(response, "status", None) or getattr(response, "code")
        return int(status), header_map, parsed


def _as_list(body: Any) -> list[Any]:
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for name in ("items", "organizations", "data", "pods", "sandboxes"):
            value = body.get(name)
            if isinstance(value, list):
                return value
    return []


def _end_of_utc_day(now: datetime) -> datetime:
    start = now.astimezone(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return start + timedelta(days=1)


def _start_of_next_month(now: datetime) -> datetime:
    moment = now.astimezone(timezone.utc)
    if moment.month == 12:
        return moment.replace(
            year=moment.year + 1,
            month=1,
            day=1,
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )
    return moment.replace(
        month=moment.month + 1,
        day=1,
        hour=0,
        minute=0,
        second=0,
        microsecond=0,
    )
