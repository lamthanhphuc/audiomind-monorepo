import json
import re
import threading
import time
from dataclasses import dataclass, field
from math import ceil
from typing import Callable

ALIAS_PATTERN = re.compile(r"^[a-z0-9_-]+$")


class GeminiKeyConfigError(ValueError):
    """Raised when Gemini key configuration is invalid without exposing secrets."""


@dataclass(frozen=True)
class GeminiKeyEntry:
    alias: str
    secret: str = field(repr=False)

    def __repr__(self) -> str:
        return f"GeminiKeyEntry(alias={self.alias!r}, secret=<redacted>)"


@dataclass(frozen=True)
class GeminiKeySelection:
    available: bool
    entry: GeminiKeyEntry | None = None
    retry_after_seconds: int = 0
    cooldown_active: int = 0


@dataclass
class _KeyState:
    disabled_until_monotonic: float = 0.0
    last_error_code: str | None = None
    last_retry_after_seconds: int = 0
    consecutive_failures: int = 0


def _safe_config_error(message: str) -> GeminiKeyConfigError:
    return GeminiKeyConfigError(f"Invalid GEMINI_API_KEYS configuration: {message}")


def _validate_alias(alias: str) -> str:
    normalized = str(alias or "").strip()
    if not normalized:
        raise _safe_config_error("alias is required")
    if not ALIAS_PATTERN.fullmatch(normalized):
        raise _safe_config_error("alias must match ^[a-z0-9_-]+$")
    return normalized


def _validate_key(value: str) -> str:
    secret = str(value or "").strip()
    if not secret:
        raise _safe_config_error("key must not be empty")
    return secret


def _validate_entries(entries: list[GeminiKeyEntry]) -> list[GeminiKeyEntry]:
    aliases: set[str] = set()
    secrets: set[str] = set()
    validated: list[GeminiKeyEntry] = []
    for entry in entries:
        alias = _validate_alias(entry.alias)
        secret = _validate_key(entry.secret)
        if alias in aliases:
            raise _safe_config_error("duplicate alias")
        if secret in secrets:
            raise _safe_config_error("duplicate key")
        aliases.add(alias)
        secrets.add(secret)
        validated.append(GeminiKeyEntry(alias=alias, secret=secret))
    if not validated:
        raise _safe_config_error("at least one key is required")
    return validated


def parse_gemini_api_keys(raw_value: str) -> list[GeminiKeyEntry]:
    raw = str(raw_value or "").strip()
    if not raw:
        return []

    try:
        if raw.startswith("["):
            parsed = json.loads(raw)
            if not isinstance(parsed, list):
                raise _safe_config_error("JSON value must be an array")
            entries = []
            for item in parsed:
                if not isinstance(item, dict):
                    raise _safe_config_error("JSON entries must be objects")
                entries.append(
                    GeminiKeyEntry(
                        alias=str(item.get("alias") or ""),
                        secret=str(item.get("key") or ""),
                    )
                )
            return _validate_entries(entries)

        entries = []
        for part in raw.split(","):
            piece = part.strip()
            if not piece or ":" not in piece:
                raise _safe_config_error("comma format must use alias:key pairs")
            alias, secret = piece.split(":", 1)
            entries.append(GeminiKeyEntry(alias=alias, secret=secret))
        return _validate_entries(entries)
    except GeminiKeyConfigError:
        raise
    except Exception as exc:
        raise _safe_config_error("could not parse value") from exc


class GeminiKeyManager:
    def __init__(
        self,
        entries: list[GeminiKeyEntry],
        *,
        clock: Callable[[], float] | None = None,
    ):
        self._entries = _validate_entries(entries)
        self._clock = clock or time.monotonic
        self._lock = threading.RLock()
        self._states = {entry.alias: _KeyState() for entry in self._entries}
        self._next_index = 0

    @classmethod
    def from_config(
        cls,
        *,
        gemini_api_key: str,
        gemini_api_keys: str = "",
        multi_key_enabled: bool = False,
        clock: Callable[[], float] | None = None,
    ) -> "GeminiKeyManager":
        if multi_key_enabled:
            parsed_entries = parse_gemini_api_keys(gemini_api_keys)
            if parsed_entries:
                return cls(parsed_entries, clock=clock)
            primary = _validate_key(gemini_api_key)
            return cls([GeminiKeyEntry(alias="primary", secret=primary)], clock=clock)

        primary = _validate_key(gemini_api_key)
        return cls([GeminiKeyEntry(alias="primary", secret=primary)], clock=clock)

    @property
    def entries(self) -> tuple[GeminiKeyEntry, ...]:
        return tuple(self._entries)

    def has_keys(self) -> bool:
        return bool(self._entries)

    def select_key(self) -> GeminiKeySelection:
        with self._lock:
            now = self._clock()
            size = len(self._entries)
            for offset in range(size):
                index = (self._next_index + offset) % size
                entry = self._entries[index]
                state = self._states[entry.alias]
                if state.disabled_until_monotonic <= now:
                    self._next_index = (index + 1) % size
                    return GeminiKeySelection(available=True, entry=entry)

            retry_after_values = [
                max(0, ceil(state.disabled_until_monotonic - now))
                for state in self._states.values()
                if state.disabled_until_monotonic > now
            ]
            retry_after = min(retry_after_values) if retry_after_values else 0
            return GeminiKeySelection(
                available=False,
                retry_after_seconds=retry_after,
                cooldown_active=len(retry_after_values),
            )

    def cooldown_key(self, alias: str, *, seconds: float, reason: str) -> None:
        self._set_cooldown(alias, seconds=seconds, reason=reason)

    def hard_cooldown_key(self, alias: str, *, seconds: float, reason: str) -> None:
        self._set_cooldown(alias, seconds=seconds, reason=reason)

    def _set_cooldown(self, alias: str, *, seconds: float, reason: str) -> None:
        with self._lock:
            state = self._states.get(alias)
            if state is None:
                return
            cooldown_seconds = max(0.0, float(seconds or 0.0))
            state.disabled_until_monotonic = max(
                state.disabled_until_monotonic,
                self._clock() + cooldown_seconds,
            )
            state.last_error_code = str(reason or "unknown")
            state.last_retry_after_seconds = int(ceil(cooldown_seconds))
            state.consecutive_failures += 1
