"""Live sandbox handle that keeps provider credentials in place."""

from __future__ import annotations

from typing import Any


class _Bound:
    """Re-apply the key's credentials around later method calls."""

    def __init__(self, router: Any, key: dict[str, Any], inner: Any) -> None:
        self._router = router
        self._key = key
        self._inner = inner

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._inner, name)
        if not callable(attr):
            return attr

        def wrapped(*args: Any, **kwargs: Any) -> Any:
            with self._router.credentials(self._key):
                return attr(*args, **kwargs)

        return wrapped


class RoutedSandbox:
    """A bespokelabs ``Sandbox`` plus the key that created it.

    Attribute access is forwarded, so ``execute_code``, ``execute_command``,
    file transfer, presets, ``run_agent``, snapshots, and the rest of the
    underlying session stay available. Calls run with that key's environment
    variables set.
    """

    def __init__(
        self,
        sandbox_id: str,
        key: dict[str, Any],
        sandbox: Any,
        router: Any,
    ) -> None:
        self.id = sandbox_id
        self.key_id = key["id"]
        self.provider = key["provider"]
        self._key = key
        self._sandbox = sandbox
        self._router = router
        self._closed = False

    @property
    def sandbox(self) -> Any:
        """The underlying bespokelabs sandbox."""
        return self._sandbox

    def destroy(self) -> None:
        """Destroy the provider sandbox and free its concurrency slot."""
        if self._closed:
            return
        with self._router.credentials(self._key):
            self._sandbox.destroy()
        self._router.release(self.id)
        self._closed = True

    def __enter__(self) -> RoutedSandbox:
        return self

    def __exit__(self, *exc: object) -> None:
        try:
            self.destroy()
        except Exception:
            if not self._closed:
                self._router.release(self.id)
                self._closed = True

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._sandbox, name)
        if not callable(attr):
            return attr

        def wrapped(*args: Any, **kwargs: Any) -> Any:
            with self._router.credentials(self._key):
                result = attr(*args, **kwargs)
            if name in {"agent", "agent_tools"} and result is not None:
                return _Bound(self._router, self._key, result)
            return result

        return wrapped
