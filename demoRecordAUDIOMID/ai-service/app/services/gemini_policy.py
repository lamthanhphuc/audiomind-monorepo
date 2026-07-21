"""Cost-aware Gemini workload, retry, and key project policies."""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Iterable
from uuid import uuid4


class GeminiWorkload(str, Enum):
    CHAT = "chat"
    SUMMARY = "summary"
    STRUCTURED_ANALYSIS = "structured_analysis"
    STUDY_ARTIFACT = "study_artifact"


_PROJECT_GROUP_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")


def parse_project_groups(
    raw_value: str,
    *,
    aliases: Iterable[str],
) -> dict[str, str]:
    """Return a total alias mapping without ever inferring independent quota."""
    configured_aliases = tuple(str(alias).strip().lower() for alias in aliases)
    if not configured_aliases:
        raise ValueError("at least one Gemini alias is required")
    raw = str(raw_value or "").strip()
    if not raw:
        return {alias: "default-project" for alias in configured_aliases}

    mapping: dict[str, str] = {}
    for item in raw.split(","):
        piece = item.strip()
        if not piece or ":" not in piece:
            raise ValueError(
                "GEMINI_KEY_PROJECT_GROUPS must use alias:project-group pairs"
            )
        alias, project_group = (part.strip().lower() for part in piece.split(":", 1))
        if alias not in configured_aliases:
            raise ValueError("GEMINI_KEY_PROJECT_GROUPS contains an unknown alias")
        if alias in mapping:
            raise ValueError("GEMINI_KEY_PROJECT_GROUPS contains a duplicate alias")
        if not _PROJECT_GROUP_PATTERN.fullmatch(project_group):
            raise ValueError(
                "Gemini project group must match ^[a-z0-9][a-z0-9._-]{0,63}$"
            )
        mapping[alias] = project_group

    missing = set(configured_aliases) - set(mapping)
    if missing:
        raise ValueError("GEMINI_KEY_PROJECT_GROUPS must map every configured alias")
    return mapping


@dataclass
class GeminiAttemptBudget:
    """One monotonic budget shared by every network attempt in an operation."""

    max_total_attempts: int
    deadline_monotonic: float | None = None
    clock: Callable[[], float] = time.monotonic
    root_operation_id: str = field(default_factory=lambda: uuid4().hex)
    _attempts_used: int = 0
    _logical_started: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def __post_init__(self) -> None:
        self.max_total_attempts = max(1, int(self.max_total_attempts or 1))

    @property
    def attempts_used(self) -> int:
        with self._lock:
            return self._attempts_used

    @property
    def remaining(self) -> int:
        with self._lock:
            return max(0, self.max_total_attempts - self._attempts_used)

    def deadline_exhausted(self) -> bool:
        return bool(
            self.deadline_monotonic is not None
            and self.clock() >= self.deadline_monotonic
        )

    def reserve(self) -> int | None:
        with self._lock:
            if self._attempts_used >= self.max_total_attempts:
                return None
            if (
                self.deadline_monotonic is not None
                and self.clock() >= self.deadline_monotonic
            ):
                return None
            self._attempts_used += 1
            return self._attempts_used

    def mark_logical_started(self) -> bool:
        """Return True exactly once for every call sharing this root budget."""
        with self._lock:
            if self._logical_started:
                return False
            self._logical_started = True
            return True
