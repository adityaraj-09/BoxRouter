"""JSON file for the round-robin cursor and per-key usage."""

from __future__ import annotations

import fcntl
import json
from pathlib import Path
from typing import Any, Iterator
from contextlib import contextmanager


def empty_state() -> dict[str, Any]:
    return {"version": 1, "cursor": 0, "keys": {}, "sandboxes": {}}


class JsonStore:
    """Exclusive file lock around read-modify-write of one JSON document."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, "a+", encoding="utf-8")

    def close(self) -> None:
        self._fh.close()

    @contextmanager
    def transaction(self) -> Iterator[dict[str, Any]]:
        fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
        state: dict[str, Any] | None = None
        try:
            self._fh.seek(0)
            raw = self._fh.read()
            state = json.loads(raw) if raw.strip() else empty_state()
            yield state
        finally:
            try:
                if state is not None:
                    self._fh.seek(0)
                    self._fh.truncate()
                    json.dump(state, self._fh, indent=2)
                    self._fh.write("\n")
                    self._fh.flush()
            finally:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
