from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4

import redis
from loguru import logger

from app.config import get_settings


@dataclass(frozen=True, slots=True)
class SttLease:
    meeting_key: str
    owner_id: str
    token: str
    fencing_token: int


class SttOwnershipLost(RuntimeError):
    pass


class SttOwnershipManager(Protocol):
    owner_id: str

    def acquire(self, meeting_key: str) -> SttLease | None: ...

    def validate(self, lease: SttLease) -> bool: ...

    def refresh(self, lease: SttLease) -> bool: ...

    def release(self, lease: SttLease) -> bool: ...

    def get_cooldown_until(self, meeting_key: str) -> float: ...

    def set_cooldown_until(self, meeting_key: str, cooldown_until: float) -> None: ...


class RedisSttOwnershipManager:
    _RELEASE_SCRIPT = """
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
    end
    return 0
    """
    _PEXPIRE_SCRIPT = """
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    end
    return 0
    """

    def __init__(
        self,
        redis_url: str,
        *,
        owner_id: str | None = None,
        lease_ttl_seconds: float = 30.0,
        cooldown_ttl_seconds: float = 300.0,
        max_connections: int = 10,
    ):
        self.owner_id = (owner_id or uuid4().hex).strip() or uuid4().hex
        self.lease_ttl_seconds = max(1.0, float(lease_ttl_seconds))
        self.cooldown_ttl_seconds = max(1.0, float(cooldown_ttl_seconds))
        pool = redis.ConnectionPool.from_url(
            redis_url,
            decode_responses=True,
            max_connections=max_connections,
        )
        self._client = redis.Redis(connection_pool=pool)

    def acquire(self, meeting_key: str) -> SttLease | None:
        key = self._lease_key(meeting_key)
        token = uuid4().hex
        fencing_token = int(self._client.incr(self._fence_key(meeting_key)))
        value = self._dump_lease(meeting_key, token, fencing_token)
        acquired = self._client.set(
            key,
            value,
            nx=True,
            px=self._lease_ttl_ms,
        )
        if not acquired:
            return None
        return SttLease(
            meeting_key=str(meeting_key),
            owner_id=self.owner_id,
            token=token,
            fencing_token=fencing_token,
        )

    def validate(self, lease: SttLease) -> bool:
        current = self._load_current_lease(lease.meeting_key)
        return (
            current is not None
            and current.get("owner_id") == lease.owner_id
            and current.get("token") == lease.token
            and int(current.get("fencing_token") or 0) == lease.fencing_token
        )

    def refresh(self, lease: SttLease) -> bool:
        expected = self._dump_lease(lease.meeting_key, lease.token, lease.fencing_token)
        return (
            int(
                self._client.eval(
                    self._PEXPIRE_SCRIPT,
                    1,
                    self._lease_key(lease.meeting_key),
                    expected,
                    self._lease_ttl_ms,
                )
            )
            == 1
        )

    def release(self, lease: SttLease) -> bool:
        expected = self._dump_lease(lease.meeting_key, lease.token, lease.fencing_token)
        return (
            int(
                self._client.eval(
                    self._RELEASE_SCRIPT,
                    1,
                    self._lease_key(lease.meeting_key),
                    expected,
                )
            )
            == 1
        )

    def get_cooldown_until(self, meeting_key: str) -> float:
        value = self._client.get(self._cooldown_key(meeting_key))
        try:
            return float(value or 0.0)
        except (TypeError, ValueError):
            return 0.0

    def set_cooldown_until(self, meeting_key: str, cooldown_until: float) -> None:
        cooldown_until = float(cooldown_until or 0.0)
        ttl_ms = max(1000, int((cooldown_until - time.time()) * 1000.0))
        if ttl_ms <= 1000:
            ttl_ms = int(self.cooldown_ttl_seconds * 1000.0)
        self._client.set(
            self._cooldown_key(meeting_key),
            str(cooldown_until),
            px=ttl_ms,
        )

    @property
    def _lease_ttl_ms(self) -> int:
        return int(self.lease_ttl_seconds * 1000.0)

    def _dump_lease(self, meeting_key: str, token: str, fencing_token: int) -> str:
        return json.dumps(
            {
                "meeting_key": str(meeting_key),
                "owner_id": self.owner_id,
                "token": token,
                "fencing_token": int(fencing_token),
            },
            sort_keys=True,
            separators=(",", ":"),
        )

    def _load_current_lease(self, meeting_key: str) -> dict[str, object] | None:
        raw = self._client.get(self._lease_key(meeting_key))
        if not raw:
            return None
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("STT_OWNERSHIP_CORRUPT_LEASE meeting_id={}", meeting_key)
            return None
        return value if isinstance(value, dict) else None

    def _lease_key(self, meeting_key: str) -> str:
        return f"stt:meeting:{meeting_key}:owner"

    def _fence_key(self, meeting_key: str) -> str:
        return f"stt:meeting:{meeting_key}:fence"

    def _cooldown_key(self, meeting_key: str) -> str:
        return f"stt:meeting:{meeting_key}:cooldown_until"


_ownership_manager: SttOwnershipManager | None = None


def get_stt_ownership_manager() -> SttOwnershipManager | None:
    global _ownership_manager
    settings = get_settings()
    if not settings.stt_ownership_enabled:
        return None
    if _ownership_manager is None:
        _ownership_manager = RedisSttOwnershipManager(
            settings.stt_ownership_redis_url or settings.job_state_redis_url,
            owner_id=settings.stt_replica_id,
            lease_ttl_seconds=settings.stt_ownership_lease_ttl_seconds,
            cooldown_ttl_seconds=settings.stt_ownership_cooldown_ttl_seconds,
            max_connections=settings.redis_max_connections,
        )
    return _ownership_manager


def reset_stt_ownership_manager() -> None:
    global _ownership_manager
    _ownership_manager = None
