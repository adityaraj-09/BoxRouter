"""Provider usage probes."""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone

from boxrouter.probes import check_provider


class _Headers(dict):
    pass


class _Response:
    def __init__(self, status: int, headers: dict, body: dict | list) -> None:
        self.status = status
        self.headers = _Headers(headers)
        self._body = json.dumps(body).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class ProbeTests(unittest.TestCase):
    def test_e2b_concurrent_header_skips_without_persisting(self) -> None:
        def opener(request, timeout):  # noqa: ANN001
            del request, timeout
            return _Response(200, {"X-Total-Running": "20"}, [])

        result = check_provider(
            {
                "provider": "e2b",
                "credentials": {"E2B_API_KEY": "k"},
                "limits": {"concurrent_sandboxes": 20},
            },
            opener=opener,
            now=datetime(2026, 10, 18, tzinfo=timezone.utc),
        )
        self.assertTrue(result.exhausted)
        self.assertFalse(result.persist)
        self.assertEqual(result.reason, "e2b concurrent sandboxes")

    def test_e2b_rate_limit_persists_until_tomorrow(self) -> None:
        def opener(request, timeout):  # noqa: ANN001
            del request, timeout
            return _Response(429, {}, {"message": "slow down"})

        now = datetime(2026, 10, 18, 15, tzinfo=timezone.utc)
        result = check_provider(
            {"provider": "e2b", "credentials": {"E2B_API_KEY": "k"}, "limits": {}},
            opener=opener,
            now=now,
        )
        self.assertTrue(result.persist)
        self.assertEqual(result.until, datetime(2026, 10, 19, tzinfo=timezone.utc))

    def test_daytona_cpu_quota(self) -> None:
        def opener(request, timeout):  # noqa: ANN001
            del timeout
            if request.full_url.endswith("/organizations"):
                return _Response(200, {}, [{"id": "org_1"}])
            return _Response(
                200,
                {},
                {
                    "regionUsage": [
                        {"totalCpuQuota": 4, "currentCpuUsage": 4},
                    ]
                },
            )

        result = check_provider(
            {
                "provider": "daytona",
                "credentials": {"DAYTONA_API_KEY": "k"},
                "limits": {},
            },
            opener=opener,
        )
        self.assertTrue(result.exhausted)
        self.assertEqual(result.reason, "daytona cpu quota")

    def test_auth_failure(self) -> None:
        def opener(request, timeout):  # noqa: ANN001
            del request, timeout
            return _Response(401, {}, {"message": "nope"})

        result = check_provider(
            {"provider": "e2b", "credentials": {"E2B_API_KEY": "k"}, "limits": {}},
            opener=opener,
        )
        self.assertTrue(result.auth_failed)
