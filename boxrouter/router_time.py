"""UTC window helpers shared by routing and billing."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


def parse_time(value: str) -> datetime:
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment


def create_time(item: Any) -> datetime:
    if isinstance(item, dict):
        return parse_time(item["at"])
    return parse_time(item)


def start_of_day(now: datetime) -> datetime:
    return now.astimezone(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def start_of_month(now: datetime) -> datetime:
    moment = now.astimezone(timezone.utc)
    return moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def start_of_next_month(now: datetime) -> datetime:
    moment = start_of_month(now)
    if moment.month == 12:
        return moment.replace(year=moment.year + 1, month=1)
    return moment.replace(month=moment.month + 1)


def end_of_day(now: datetime) -> datetime:
    return start_of_day(now) + timedelta(days=1)
