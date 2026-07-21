"""Phase 2 study generation helpers: hashing, statuses, exceptions."""

from __future__ import annotations

import hashlib
import json
from typing import Any

STATUS_QUEUED = "QUEUED"
STATUS_PROCESSING = "PROCESSING"
STATUS_COMPLETED = "COMPLETED"
STATUS_FAILED = "FAILED"
STATUS_STALE = "STALE"
STATUS_QUOTA_EXCEEDED = "QUOTA_EXCEEDED"

AGG_QUEUED = "QUEUED"
AGG_PROCESSING = "PROCESSING"
AGG_COMPLETED = "COMPLETED"
AGG_PARTIALLY_FAILED = "PARTIALLY_FAILED"
AGG_FAILED = "FAILED"

MODE_ALL_READY = "ALL_READY"
MODE_EXPLICIT = "EXPLICIT"

ARTIFACT_MIND_MAP = "MIND_MAP"
ARTIFACT_FLASHCARDS = "FLASHCARDS"
ARTIFACT_MULTIPLE_CHOICE = "MULTIPLE_CHOICE"
ARTIFACT_ESSAY_QUESTIONS = "ESSAY_QUESTIONS"
ARTIFACT_EXAM_BRIEF = "EXAM_BRIEF"

ALL_ARTIFACT_TYPES = (
    ARTIFACT_MIND_MAP,
    ARTIFACT_FLASHCARDS,
    ARTIFACT_MULTIPLE_CHOICE,
    ARTIFACT_ESSAY_QUESTIONS,
    ARTIFACT_EXAM_BRIEF,
)

SYNTHESIS_PROMPT_VERSION = "subject-synthesis-v1"
SYNTHESIS_SCHEMA_VERSION = "subject-synthesis-schema-v1"

ARTIFACT_VERSIONS: dict[str, tuple[str, str]] = {
    ARTIFACT_MIND_MAP: ("mind-map-v1", "mind-map-schema-v1"),
    ARTIFACT_FLASHCARDS: ("flashcards-v1", "flashcards-schema-v1"),
    ARTIFACT_MULTIPLE_CHOICE: ("multiple-choice-v1", "multiple-choice-schema-v1"),
    ARTIFACT_ESSAY_QUESTIONS: ("essay-questions-v1", "essay-questions-schema-v1"),
    ARTIFACT_EXAM_BRIEF: ("exam-brief-v1", "exam-brief-schema-v1"),
}

IN_FLIGHT = {STATUS_QUEUED, STATUS_PROCESSING}
TERMINAL_SUCCESS = {STATUS_COMPLETED, STATUS_STALE}
TERMINAL_FAILURE = {STATUS_FAILED, STATUS_QUOTA_EXCEEDED}


class StudyValidationError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class StudyAuthorizationError(Exception):
    def __init__(self, message: str = "Forbidden"):
        super().__init__(message)


class StudySourceNotReadyError(Exception):
    def __init__(self, meeting_ids: list[int]):
        super().__init__("SOURCE_MEETINGS_NOT_READY")
        self.meeting_ids = meeting_ids
        self.code = "SOURCE_MEETINGS_NOT_READY"


class StudyTransientError(Exception):
    """Retryable AI/network failure."""

    def __init__(self, message: str = "transient", code: str | None = None):
        super().__init__(message)
        self.message = message
        self.code = code or "TRANSIENT_ERROR"


def canonical_json_dumps(payload: Any) -> str:
    return json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


def sha256_hex(payload: Any) -> str:
    raw = canonical_json_dumps(payload).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def build_source_hash(
    *,
    subject_id: int,
    sources: list[dict[str, Any]],
    source_selection_mode: str,
) -> str:
    normalized = sorted(
        [
            {
                "meetingId": int(s["meetingId"]),
                "transcriptHash": s.get("transcriptHash") or "",
                "analysisRunId": s.get("analysisRunId"),
                "analysisVersion": s.get("analysisVersion") or "",
            }
            for s in sources
        ],
        key=lambda item: item["meetingId"],
    )
    return sha256_hex(
        {
            "subjectId": int(subject_id),
            "sourceSelectionMode": source_selection_mode,
            "sources": normalized,
        }
    )


def build_options_hash(options: dict[str, Any] | None) -> str:
    return sha256_hex(options or {})


def build_idempotency_key(
    *,
    owner_user_id: int,
    subject_id: int,
    artifact_type: str,
    source_hash: str,
    options_hash: str,
    prompt_version: str,
    schema_version: str,
    source_selection_mode: str,
    force_token: str | None = None,
) -> str:
    parts = [
        str(owner_user_id),
        str(subject_id),
        artifact_type,
        source_hash,
        options_hash,
        prompt_version,
        schema_version,
        source_selection_mode,
    ]
    if force_token:
        parts.append(force_token)
    return "|".join(parts)


def aggregate_statuses(statuses: list[str]) -> str:
    if not statuses:
        return AGG_FAILED
    if any(s == STATUS_PROCESSING for s in statuses):
        return AGG_PROCESSING
    if any(s == STATUS_QUEUED for s in statuses):
        return AGG_QUEUED
    failures = [s for s in statuses if s in TERMINAL_FAILURE]
    successes = [s for s in statuses if s in TERMINAL_SUCCESS]
    if failures and successes:
        return AGG_PARTIALLY_FAILED
    if failures and not successes:
        return AGG_FAILED
    if successes and not failures:
        return AGG_COMPLETED
    return AGG_PROCESSING
