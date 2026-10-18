"""Errors raised by the router."""


class BoxRouterError(Exception):
    """Base error for BoxRouter."""


class NoEligibleKey(BoxRouterError):
    """Every configured key is exhausted, invalid, or failed this attempt."""


class ConfigError(BoxRouterError):
    """The key configuration is missing or malformed."""
