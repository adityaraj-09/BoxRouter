"""Router selection, usage file, and credential injection."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from boxrouter.errors import NoEligibleKey
from boxrouter.probes import ProbeResult
from boxrouter.router import Router


class FakeSandbox:
    def __init__(self, backend: str, **kwargs: object) -> None:
        self.backend_name = backend
        self.kwargs = kwargs
        self.provider_resource_id = f"{backend}-resource"
        self.destroyed = False
        self.seen_key = os.environ.get("E2B_API_KEY") or os.environ.get(
            "MODAL_TOKEN_ID"
        )

    def destroy(self) -> None:
        self.destroyed = True

    def execute_code(self, code: str, language: str = "python") -> str:
        del language
        return f"{self.seen_key}:{code}"


def _config(*keys: dict) -> dict:
    return {"keys": list(keys)}


def _key(key_id: str, provider: str, **limits: int) -> dict:
    env = (
        {"E2B_API_KEY": f"secret-{key_id}"}
        if provider == "e2b"
        else {"MODAL_TOKEN_ID": f"id-{key_id}", "MODAL_TOKEN_SECRET": "s"}
    )
    return {
        "id": key_id,
        "provider": provider,
        "credentials": env,
        "limits": limits,
    }


def _ok(_key: dict) -> ProbeResult:
    return ProbeResult(detail="ok")


class RouterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.state = Path(self._tmp.name) / "usage.json"
        self.now = datetime(2026, 10, 18, 12, tzinfo=timezone.utc)

    def _router(self, config: dict, **kwargs: object) -> Router:
        router = Router(
            config,
            state_path=self.state,
            sandbox_factory=kwargs.get("sandbox_factory", FakeSandbox),
            probe=kwargs.get("probe", _ok),
            now=lambda: self.now,
        )
        self.addCleanup(router.close)
        return router

    def test_round_robin_order(self) -> None:
        router = self._router(
            _config(
                _key("a", "e2b"),
                _key("b", "modal"),
                _key("c", "e2b"),
            )
        )
        created = [router.create().key_id for _ in range(4)]
        self.assertEqual(created, ["a", "b", "c", "a"])

    def test_backend_filter_stays_on_that_provider(self) -> None:
        router = self._router(
            _config(_key("a", "e2b"), _key("b", "modal"), _key("c", "e2b"))
        )
        self.assertEqual(router.create(backend="e2b").key_id, "a")
        self.assertEqual(router.create(backend="e2b").key_id, "c")
        self.assertEqual(router.create(backend="modal").provider, "modal")

    def test_credentials_are_visible_during_create_and_calls(self) -> None:
        router = self._router(_config(_key("a", "e2b")))
        sandbox = router.create()
        self.assertEqual(sandbox.sandbox.seen_key, "secret-a")
        self.assertIsNone(os.environ.get("E2B_API_KEY"))
        self.assertEqual(sandbox.execute_code("print(1)"), "secret-a:print(1)")
        self.assertIsNone(os.environ.get("E2B_API_KEY"))

    def test_daily_limit_blocks_until_next_day(self) -> None:
        router = self._router(_config(_key("a", "e2b", creates_per_day=1)))
        router.create()
        with self.assertRaises(NoEligibleKey):
            router.create()
        status = router.status()[0]
        self.assertEqual(status["blocked_reason"], "creates_per_day")
        self.assertEqual(status["creates_today"], 1)
        self.now = datetime(2026, 10, 19, 1, tzinfo=timezone.utc)
        self.assertEqual(router.create().key_id, "a")

    def test_monthly_limit_resets_next_month(self) -> None:
        router = self._router(_config(_key("a", "e2b", creates_per_month=1)))
        router.create()
        with self.assertRaises(NoEligibleKey):
            router.create()
        self.now = datetime(2026, 11, 1, tzinfo=timezone.utc)
        self.assertEqual(router.create().key_id, "a")

    def test_concurrent_slot_frees_on_destroy(self) -> None:
        router = self._router(
            _config(_key("a", "e2b", concurrent_sandboxes=1))
        )
        first = router.create()
        with self.assertRaises(NoEligibleKey):
            router.create()
        first.destroy()
        self.assertTrue(first.sandbox.destroyed)
        self.assertEqual(router.create().key_id, "a")

    def test_probe_exhaustion_moves_to_the_next_key(self) -> None:
        def probe(key: dict) -> ProbeResult:
            if key["id"] == "a":
                return ProbeResult(exhausted=True, reason="e2b concurrent sandboxes")
            return ProbeResult(detail="ok")

        router = self._router(
            _config(_key("a", "e2b"), _key("b", "modal")),
            probe=probe,
        )
        self.assertEqual(router.create().key_id, "b")
        self.assertEqual(router.status()[0]["last_probe"]["reason"], "e2b concurrent sandboxes")

    def test_provider_quota_error_tries_the_next_key(self) -> None:
        calls: list[str] = []

        def factory(backend: str, **kwargs: object) -> FakeSandbox:
            del kwargs
            calls.append(backend)
            if backend == "e2b":
                raise RuntimeError("HTTP 429 quota exceeded")
            return FakeSandbox(backend)

        router = self._router(
            _config(_key("a", "e2b"), _key("b", "modal")),
            sandbox_factory=factory,
        )
        sandbox = router.create()
        self.assertEqual(sandbox.provider, "modal")
        self.assertEqual(calls, ["e2b", "modal"])
        saved = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual(saved["keys"]["a"]["blocked_reason"], "HTTP 429 quota exceeded")
        self.assertEqual(saved["keys"]["a"]["active"], [])
        self.assertEqual(len(saved["keys"]["b"]["active"]), 1)

    def test_usage_file_omits_secrets(self) -> None:
        router = self._router(_config(_key("a", "e2b")))
        router.create()
        raw = self.state.read_text(encoding="utf-8")
        self.assertNotIn("secret-a", raw)


if __name__ == "__main__":
    unittest.main()
