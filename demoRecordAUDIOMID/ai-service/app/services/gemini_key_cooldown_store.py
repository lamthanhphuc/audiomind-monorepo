from __future__ import annotations

import json
import time
from dataclasses import dataclass
from math import ceil
from typing import Callable, Protocol


@dataclass(frozen=True)
class GeminiCooldownState:
    remaining_seconds: float
    reason: str | None = None
    cooldown_type: str | None = None


class GeminiKeyCooldownStore(Protocol):
    def cooldown_remaining(self, alias: str, *, now: float) -> float: ...

    def apply_cooldown(
        self,
        alias: str,
        *,
        seconds: float,
        reason: str | None = None,
        cooldown_type: str | None = None,
    ) -> None: ...

    def get_cooldown_state(
        self, alias: str, *, now: float
    ) -> GeminiCooldownState | None: ...

    def clear_cooldown(self, alias: str) -> None: ...

    def mark_model_unsupported(self, alias: str, model: str) -> None: ...

    def is_model_unsupported(self, alias: str, model: str) -> bool: ...


def _normalize_reason(reason: str | None) -> str | None:
    normalized = str(reason or "").strip()
    return normalized or None


class InMemoryGeminiKeyCooldownStore:
    def __init__(self, clock: Callable[[], float] | None = None) -> None:
        self._clock = clock or time.monotonic
        self._disabled_until: dict[str, float] = {}
        self._cooldown_meta: dict[str, dict[str, str | None]] = {}
        self._unsupported_models: dict[str, set[str]] = {}

    def cooldown_remaining(self, alias: str, *, now: float) -> float:
        del now  # Use store clock for consistency with apply_cooldown.
        disabled_until = float(self._disabled_until.get(alias, 0.0))
        return max(0.0, disabled_until - self._clock())

    def get_cooldown_state(
        self, alias: str, *, now: float
    ) -> GeminiCooldownState | None:
        del now
        remaining = self.cooldown_remaining(alias, now=self._clock())
        if remaining <= 0:
            return None
        meta = self._cooldown_meta.get(alias, {})
        return GeminiCooldownState(
            remaining_seconds=remaining,
            reason=_normalize_reason(meta.get("reason")),
            cooldown_type=_normalize_reason(meta.get("cooldown_type")),
        )

    def apply_cooldown(
        self,
        alias: str,
        *,
        seconds: float,
        reason: str | None = None,
        cooldown_type: str | None = None,
    ) -> None:
        cooldown_seconds = max(0.0, float(seconds or 0.0))
        now = self._clock()
        self._disabled_until[alias] = max(
            float(self._disabled_until.get(alias, 0.0)),
            now + cooldown_seconds,
        )
        self._cooldown_meta[alias] = {
            "reason": _normalize_reason(reason),
            "cooldown_type": _normalize_reason(cooldown_type),
        }

    def clear_cooldown(self, alias: str) -> None:
        self._disabled_until.pop(alias, None)
        self._cooldown_meta.pop(alias, None)

    def mark_model_unsupported(self, alias: str, model: str) -> None:
        normalized_alias = str(alias or "").strip()
        normalized_model = str(model or "").strip().lower()
        if not normalized_alias or not normalized_model:
            return
        if normalized_model.startswith("models/"):
            normalized_model = normalized_model[len("models/") :]
        if ":" in normalized_model:
            normalized_model = normalized_model.split(":", 1)[0]
        unsupported = self._unsupported_models.setdefault(normalized_alias, set())
        unsupported.add(normalized_model.strip())

    def is_model_unsupported(self, alias: str, model: str) -> bool:
        normalized_alias = str(alias or "").strip()
        normalized_model = str(model or "").strip().lower()
        if normalized_model.startswith("models/"):
            normalized_model = normalized_model[len("models/") :]
        if ":" in normalized_model:
            normalized_model = normalized_model.split(":", 1)[0]
        return normalized_model in self._unsupported_models.get(normalized_alias, set())


class RedisGeminiKeyCooldownStore:
    """Shared cooldown markers across ai-api replicas using Redis TTL."""

    KEY_PREFIX = "gemini:key-cooldown:"
    MODEL_UNSUPPORTED_PREFIX = "gemini:key-model-unsupported:"

    def __init__(self, redis_client):
        self._redis = redis_client

    def _cooldown_key(self, alias: str) -> str:
        return f"{self.KEY_PREFIX}{alias}"

    def _model_key(self, alias: str, model: str) -> str:
        return f"{self.MODEL_UNSUPPORTED_PREFIX}{alias}:{model}"

    @staticmethod
    def _encode_payload(
        reason: str | None, cooldown_type: str | None
    ) -> str:
        payload = {
            "reason": _normalize_reason(reason),
            "type": _normalize_reason(cooldown_type),
        }
        return json.dumps(payload, separators=(",", ":"))

    @staticmethod
    def _decode_payload(raw: str | None) -> tuple[str | None, str | None]:
        if not raw or raw == "1":
            return None, None
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None, None
        if not isinstance(parsed, dict):
            return None, None
        return (
            _normalize_reason(parsed.get("reason")),
            _normalize_reason(parsed.get("type") or parsed.get("cooldown_type")),
        )

    def cooldown_remaining(self, alias: str, *, now: float) -> float:
        del now  # Redis TTL is wall-clock based.
        ttl = self._redis.ttl(self._cooldown_key(alias))
        return float(max(0, int(ttl)))

    def get_cooldown_state(
        self, alias: str, *, now: float
    ) -> GeminiCooldownState | None:
        del now
        key = self._cooldown_key(alias)
        ttl = int(self._redis.ttl(key))
        if ttl <= 0:
            return None
        raw = self._redis.get(key)
        reason, cooldown_type = self._decode_payload(raw)
        return GeminiCooldownState(
            remaining_seconds=float(ttl),
            reason=reason,
            cooldown_type=cooldown_type,
        )

    def apply_cooldown(
        self,
        alias: str,
        *,
        seconds: float,
        reason: str | None = None,
        cooldown_type: str | None = None,
    ) -> None:
        key = self._cooldown_key(alias)
        cooldown_seconds = max(1, int(ceil(float(seconds or 0.0))))
        current_ttl = int(self._redis.ttl(key))
        payload = self._encode_payload(reason, cooldown_type)
        if current_ttl < 0 or cooldown_seconds > current_ttl:
            self._redis.setex(key, cooldown_seconds, payload)

    def clear_cooldown(self, alias: str) -> None:
        self._redis.delete(self._cooldown_key(alias))

    def mark_model_unsupported(self, alias: str, model: str) -> None:
        normalized_alias = str(alias or "").strip()
        normalized_model = str(model or "").strip().lower()
        if normalized_model.startswith("models/"):
            normalized_model = normalized_model[len("models/") :]
        if ":" in normalized_model:
            normalized_model = normalized_model.split(":", 1)[0]
        normalized_model = normalized_model.strip()
        if not normalized_alias or not normalized_model:
            return
        self._redis.set(self._model_key(normalized_alias, normalized_model), "1")

    def is_model_unsupported(self, alias: str, model: str) -> bool:
        normalized_alias = str(alias or "").strip()
        normalized_model = str(model or "").strip().lower()
        if normalized_model.startswith("models/"):
            normalized_model = normalized_model[len("models/") :]
        if ":" in normalized_model:
            normalized_model = normalized_model.split(":", 1)[0]
        normalized_model = normalized_model.strip()
        if not normalized_alias or not normalized_model:
            return False
        return bool(self._redis.exists(self._model_key(normalized_alias, normalized_model)))
