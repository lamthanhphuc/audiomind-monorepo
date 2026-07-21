"""Prepare / dispatch / CRUD for subject synthesis and study artifacts."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import (
    StudyArtifact,
    StudyArtifactSource,
    SubjectSynthesis,
    SubjectSynthesisSource,
)
from app.services.study import (
    ALL_ARTIFACT_TYPES,
    ARTIFACT_VERSIONS,
    IN_FLIGHT,
    MODE_ALL_READY,
    MODE_EXPLICIT,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_PROCESSING,
    STATUS_QUEUED,
    STATUS_STALE,
    STATUS_QUOTA_EXCEEDED,
    STATUS_STALE,
    StudyAuthorizationError,
    StudySourceNotReadyError,
    StudyTransientError,
    StudyValidationError,
    aggregate_statuses,
    build_idempotency_key,
    build_options_hash,
    build_source_hash,
)
from app.services.study.artifacts import generate_artifact_content, validate_options
from app.services.study.exceptions import classify_provider_exception, is_transient_provider_error
from app.services.study.membership import (
    MeetingMembershipUnavailableError,
    fetch_subject_meeting_ids,
    hash_membership,
)
from app.services.study.source_resolve import resolve_study_sources
from app.services.study.synthesis import run_hierarchical_synthesis, synthesis_versions

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.utcnow()


def _live_synthesis_query(db: Session):
    return db.query(SubjectSynthesis).filter(SubjectSynthesis.deleted_at.is_(None))


def _live_artifact_query(db: Session):
    return db.query(StudyArtifact).filter(StudyArtifact.deleted_at.is_(None))


def _attach_sources_payload(sources: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "meetingId": s.meeting_id,
            "transcriptHash": s.transcript_hash,
            "analysisRunId": s.analysis_run_id,
            "analysisVersion": s.analysis_version,
        }
        for s in sources
    ]


def serialize_synthesis(row: SubjectSynthesis, *, stale: bool = False) -> dict[str, Any]:
    status = STATUS_STALE if stale and row.status == STATUS_COMPLETED else row.status
    options = row.options_json if isinstance(row.options_json, dict) else {}
    return {
        "id": row.id,
        "subjectId": row.subject_id,
        "ownerUserId": row.owner_user_id,
        "status": status,
        "version": row.version,
        "title": row.title,
        "content": row.content_json,
        "options": options,
        "sourceHash": row.source_hash,
        "optionsHash": row.options_hash,
        "sourceSelectionMode": row.source_selection_mode,
        "promptVersion": row.prompt_version,
        "schemaVersion": row.schema_version,
        "errorCode": row.error_code,
        "errorMessage": row.error_message,
        "warnings": row.warnings_json,
        "generatedAt": row.generated_at.isoformat() + "Z" if row.generated_at else None,
        "createdAt": row.created_at.isoformat() + "Z" if row.created_at else None,
        "updatedAt": row.updated_at.isoformat() + "Z" if row.updated_at else None,
        "sourceMeetingIds": [s.meeting_id for s in (row.sources or [])],
        "sources": _attach_sources_payload(row.sources or []),
        "stale": stale,
        "cacheHit": False,
        "celeryTaskId": row.celery_task_id,
    }


def serialize_artifact(row: StudyArtifact, *, stale: bool = False) -> dict[str, Any]:
    status = STATUS_STALE if stale and row.status == STATUS_COMPLETED else row.status
    return {
        "id": row.id,
        "subjectId": row.subject_id,
        "ownerUserId": row.owner_user_id,
        "synthesisId": row.synthesis_id,
        "artifactType": row.artifact_type,
        "status": status,
        "version": row.version,
        "title": row.title,
        "options": row.options_json,
        "content": row.content_json,
        "sourceHash": row.source_hash,
        "optionsHash": row.options_hash,
        "sourceSelectionMode": row.source_selection_mode,
        "promptVersion": row.prompt_version,
        "schemaVersion": row.schema_version,
        "generationRequestId": row.generation_request_id,
        "errorCode": row.error_code,
        "errorMessage": row.error_message,
        "warnings": row.warnings_json,
        "generatedAt": row.generated_at.isoformat() + "Z" if row.generated_at else None,
        "createdAt": row.created_at.isoformat() + "Z" if row.created_at else None,
        "updatedAt": row.updated_at.isoformat() + "Z" if row.updated_at else None,
        "sourceMeetingIds": [s.meeting_id for s in (row.sources or [])],
        "sources": _attach_sources_payload(row.sources or []),
        "stale": stale,
        "cacheHit": False,
        "celeryTaskId": row.celery_task_id,
    }


def _source_rows_from_ready(ready: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "meetingId": int(s["meetingId"]),
            "transcriptHash": s.get("canonicalTranscriptHash"),
            "analysisRunId": s.get("analysisRunId"),
            "analysisVersion": s.get("schemaVersion") or s.get("analysisFeatureSet"),
        }
        for s in ready
    ]


def compute_current_source_hash(
    db: Session,
    *,
    owner_user_id: int,
    subject_id: int,
    source_selection_mode: str,
    meeting_ids: list[int],
    require_ready: bool = True,
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    """Compute provenance hash for the given meeting set.

    When ``require_ready`` is False (stale checks), an empty or not-ready set
    still yields a comparable hash instead of raising — empty current set must
    stale artifacts that still have stored sources.
    """
    resolved = resolve_study_sources(db, owner_user_id=owner_user_id, meeting_ids=meeting_ids)
    if source_selection_mode == MODE_ALL_READY:
        ready = [r for r in resolved if r.get("ready")]
    else:
        not_ready = [int(r["meetingId"]) for r in resolved if not r.get("ready")]
        if not_ready and require_ready:
            raise StudySourceNotReadyError(not_ready)
        ready = [r for r in resolved if r.get("ready")]
    if not ready:
        if require_ready:
            raise StudySourceNotReadyError([int(m) for m in meeting_ids] if meeting_ids else [])
        source_rows: list[dict[str, Any]] = []
        return (
            build_source_hash(
                subject_id=subject_id,
                sources=source_rows,
                source_selection_mode=source_selection_mode,
            ),
            [],
            source_rows,
        )
    source_rows = _source_rows_from_ready(ready)
    return (
        build_source_hash(
            subject_id=subject_id,
            sources=source_rows,
            source_selection_mode=source_selection_mode,
        ),
        ready,
        source_rows,
    )


def is_stale_against_current(
    *,
    stored_source_hash: str,
    current_source_hash: str,
) -> bool:
    return stored_source_hash != current_source_hash


def _classify_existing(status: str) -> str | None:
    """Return cacheHit / inFlight / None (retryable terminal)."""
    if status == STATUS_COMPLETED:
        return "cacheHit"
    if status in IN_FLIGHT:
        return "inFlight"
    return None


def _is_lease_active(requested_at: datetime | None, ttl_seconds: int) -> bool:
    if requested_at is None:
        return False
    return requested_at >= _now() - timedelta(seconds=ttl_seconds)


def _is_dispatchable_row(row: Any) -> bool:
    """QUEUED + quota confirmed + not deleted + lease null/expired + retry due."""
    if getattr(row, "deleted_at", None) is not None:
        return False
    if row.status != STATUS_QUEUED:
        return False
    if getattr(row, "quota_confirmed_at", None) is None:
        return False
    settings = get_settings()
    if _is_lease_active(
        getattr(row, "dispatch_requested_at", None),
        settings.study_dispatch_lease_seconds,
    ):
        return False
    next_retry = getattr(row, "next_dispatch_retry_at", None)
    if next_retry is not None and next_retry > _now():
        return False
    return True


def _classify_prepare_row(row: Any) -> str | None:
    """Classify an existing live row for prepare responses.

    Returns: cacheHit | inFlight | dispatchable | needsQuota | None (retryable terminal).
    """
    if row.status == STATUS_COMPLETED:
        return "cacheHit"
    if row.status == STATUS_PROCESSING:
        return "inFlight"
    if row.status == STATUS_QUEUED:
        settings = get_settings()
        if _is_lease_active(
            getattr(row, "dispatch_requested_at", None),
            settings.study_dispatch_lease_seconds,
        ):
            return "inFlight"
        if getattr(row, "quota_confirmed_at", None) is None:
            return "needsQuota"
        if _is_dispatchable_row(row):
            return "dispatchable"
        # Quota confirmed but waiting on retry backoff.
        return "inFlight"
    return None


def _requeue_for_transient_retry(row: Any, error_code: str, error_message: str) -> None:
    """Return job to QUEUED for Celery retry without marking FAILED."""
    row.status = STATUS_QUEUED
    row.processing_started_at = None
    row.last_heartbeat_at = None
    # Keep attempt_count — claim_processing already incremented it.
    row.error_code = error_code
    row.error_message = error_message
    row.updated_at = _now()


def _mark_terminal_failed(
    row: Any,
    *,
    error_code: str,
    error_message: str,
) -> None:
    row.status = STATUS_FAILED
    row.error_code = error_code
    row.error_message = error_message
    row.updated_at = _now()


def _guard_source_hash_unchanged(
    db: Session,
    row: Any,
    meeting_ids: list[int],
) -> None:
    """Fail fast if sources/membership changed after prepare; marks STALE and raises."""
    stored_ids = [int(m) for m in meeting_ids]
    mode = row.source_selection_mode

    try:
        current_membership = fetch_subject_meeting_ids(
            int(row.subject_id), int(row.owner_user_id)
        )
    except MeetingMembershipUnavailableError:
        # Unit tests / local without meeting-service: fall back to stored ids.
        current_membership = list(stored_ids)

    membership_set = {int(x) for x in current_membership}
    stored_membership_hash = getattr(row, "subject_membership_hash", None)

    if mode == MODE_ALL_READY:
        hash_ids = list(current_membership)
        if stored_membership_hash and hash_membership(current_membership) != stored_membership_hash:
            _mark_source_changed(db, row)
            raise StudyValidationError(
                "SOURCE_CHANGED_AFTER_PREPARE",
                "Subject membership changed after prepare",
            )
    else:
        # EXPLICIT: selection is fixed; new meetings outside selection do not change hash.
        # Meetings that left the subject are stale.
        if any(m not in membership_set for m in stored_ids):
            _mark_source_changed(db, row)
            raise StudyValidationError(
                "SOURCE_CHANGED_AFTER_PREPARE",
                "Explicit source meeting left subject membership",
            )
        hash_ids = list(stored_ids)

    current_hash, _, _ = compute_current_source_hash(
        db,
        owner_user_id=int(row.owner_user_id),
        subject_id=int(row.subject_id),
        source_selection_mode=mode,
        meeting_ids=hash_ids,
        require_ready=False,
    )
    if current_hash == row.source_hash:
        return
    _mark_source_changed(db, row)
    raise StudyValidationError(
        "SOURCE_CHANGED_AFTER_PREPARE",
        "Source hash changed after prepare",
    )


def _mark_source_changed(db: Session, row: Any) -> None:
    row.status = STATUS_STALE
    row.error_code = "SOURCE_CHANGED_AFTER_PREPARE"
    row.error_message = "Source hash changed after prepare"
    row.updated_at = _now()
    db.commit()


def _record_dispatch_broker_failure(row: Any, error_message: str) -> None:
    """After releasing a claim: backoff or terminal DISPATCH_EXHAUSTED.

    Does NOT increment dispatch_attempt_count — claim_dispatch already counted
    the publish attempt.
    """
    settings = get_settings()
    count = int(getattr(row, "dispatch_attempt_count", 0) or 0)
    row.last_dispatch_error = (error_message or "")[:500]
    row.last_dispatch_error_at = _now()
    if count >= settings.study_dispatch_max_attempts:
        row.status = STATUS_FAILED
        row.error_code = "DISPATCH_EXHAUSTED"
        row.error_message = "Dispatch attempts exhausted"
        row.next_dispatch_retry_at = None
    else:
        backoff = settings.study_dispatch_retry_backoff_seconds * max(1, count)
        row.next_dispatch_retry_at = _now() + timedelta(seconds=backoff)
    row.updated_at = _now()


# Shared classifier lives in exceptions.py; keep private alias for call sites.
_is_transient_provider_error = is_transient_provider_error


def _mark_or_requeue_classified(
    db: Session,
    row: Any,
    *,
    exc: BaseException,
    event_name: str,
    entity_id: int,
) -> BaseException | None:
    """Handle ValueError-family errors after classification.

    JSONDecodeError is a ValueError subclass; classify before PROGRAMMING_ERROR.
    Returns a StudyTransientError to re-raise, or None when terminal handling is done.
    """
    classified = classify_provider_exception(exc)
    if isinstance(classified, StudyValidationError):
        _mark_terminal_failed(
            row,
            error_code=getattr(classified, "code", "VALIDATION_ERROR"),
            error_message=str(classified),
        )
        db.commit()
        logger.info("event=%s entityId=%s code=%s", event_name, entity_id, row.error_code)
        return None
    if isinstance(classified, StudyTransientError):
        _requeue_for_transient_retry(row, "TRANSIENT_AI_ERROR", str(classified)[:500])
        db.commit()
        return classified
    _mark_terminal_failed(
        row,
        error_code="PROGRAMMING_ERROR",
        error_message=f"INTERNAL_ERROR: {type(exc).__name__}: {exc}"[:500],
    )
    db.commit()
    logger.info("event=%s entityId=%s code=PROGRAMMING_ERROR", event_name, entity_id)
    return None


def _soft_delete_for_retry(db: Session, row: Any) -> None:
    row.deleted_at = _now()
    row.updated_at = _now()
    db.flush()


def resolve_compatible_synthesis(
    db: Session,
    *,
    owner_user_id: int,
    subject_id: int,
    source_hash: str,
    source_selection_mode: str,
    synthesis_id: int | None = None,
) -> SubjectSynthesis | None:
    """Validate synthesis hint or auto-select latest compatible COMPLETED synthesis.

    Raises StudyValidationError with SYNTHESIS_* codes without leaking foreign content.
    Returns None when no synthesis is requested/available (artifacts may proceed without).
    """
    if synthesis_id is None:
        return (
            _live_synthesis_query(db)
            .filter(
                SubjectSynthesis.owner_user_id == owner_user_id,
                SubjectSynthesis.subject_id == subject_id,
                SubjectSynthesis.status == STATUS_COMPLETED,
                SubjectSynthesis.source_hash == source_hash,
                SubjectSynthesis.source_selection_mode == source_selection_mode,
            )
            .order_by(SubjectSynthesis.version.desc(), SubjectSynthesis.id.desc())
            .first()
        )

    row = (
        _live_synthesis_query(db)
        .filter(SubjectSynthesis.id == synthesis_id)
        .first()
    )
    if row is None:
        raise StudyValidationError("SYNTHESIS_NOT_FOUND", "Synthesis not found")
    if int(row.owner_user_id) != int(owner_user_id):
        raise StudyValidationError("SYNTHESIS_NOT_OWNED", "Synthesis not found")
    if int(row.subject_id) != int(subject_id):
        raise StudyValidationError("SYNTHESIS_SUBJECT_MISMATCH", "Synthesis subject mismatch")
    if row.status != STATUS_COMPLETED:
        raise StudyValidationError(
            "SYNTHESIS_NOT_READY",
            f"Synthesis status is {row.status}",
        )
    if row.source_hash != source_hash or row.source_selection_mode != source_selection_mode:
        raise StudyValidationError("SYNTHESIS_SOURCE_MISMATCH", "Synthesis source mismatch")
    return row


def _load_compatible_synthesis_content(
    db: Session,
    *,
    synthesis_id: int | None,
    owner_user_id: int,
    subject_id: int,
    source_hash: str,
    source_selection_mode: str,
) -> dict[str, Any] | None:
    """Load synthesis content if still compatible.

    On SYNTHESIS_SOURCE_MISMATCH (or other rejection of a hint), fall back to
    ``None`` so the artifact can generate from educationStudy only — do not fail.
    When ``synthesis_id`` is None, auto-select the latest compatible COMPLETED
    synthesis if one exists.
    """
    try:
        row = resolve_compatible_synthesis(
            db,
            owner_user_id=owner_user_id,
            subject_id=subject_id,
            source_hash=source_hash,
            source_selection_mode=source_selection_mode,
            synthesis_id=synthesis_id,
        )
    except StudyValidationError as exc:
        if exc.code == "SYNTHESIS_SOURCE_MISMATCH":
            logger.info(
                "event=STUDY_ARTIFACT_SYNTHESIS_MISMATCH_FALLBACK owner=%s synthesisId=%s",
                owner_user_id,
                synthesis_id,
            )
            return None
        logger.warning(
            "event=STUDY_ARTIFACT_SYNTHESIS_REJECTED artifactOwner=%s synthesisId=%s code=%s",
            owner_user_id,
            synthesis_id,
            exc.code,
        )
        return None
    if row is None or not isinstance(row.content_json, dict):
        return None
    return row.content_json


def evaluate_stale_for_row(
    db: Session,
    *,
    owner_user_id: int,
    subject_id: int,
    source_selection_mode: str,
    stored_source_hash: str,
    stored_source_meeting_ids: list[int],
    current_subject_meeting_ids: list[int] | None,
) -> bool:
    """Stale detection for COMPLETED rows. Empty current ALL_READY set is stale."""
    if source_selection_mode == MODE_ALL_READY:
        # None = caller did not provide stale context; [] = empty subject.
        if current_subject_meeting_ids is None:
            return False
        meeting_ids = list(current_subject_meeting_ids)
        if stored_source_meeting_ids and not meeting_ids:
            return True
    else:
        meeting_ids = list(stored_source_meeting_ids)
        # EXPLICIT: if any stored source left the subject, treat as stale.
        if current_subject_meeting_ids is not None:
            subject_set = set(int(x) for x in current_subject_meeting_ids)
            if any(int(m) not in subject_set for m in meeting_ids):
                return True

    try:
        current_hash, _, _ = compute_current_source_hash(
            db,
            owner_user_id=owner_user_id,
            subject_id=subject_id,
            source_selection_mode=source_selection_mode,
            meeting_ids=meeting_ids,
            require_ready=False,
        )
        return is_stale_against_current(
            stored_source_hash=stored_source_hash,
            current_source_hash=current_hash,
        )
    except StudySourceNotReadyError:
        return True


def prepare_synthesis(
    db: Session,
    *,
    owner_user_id: int,
    subject_id: int,
    meeting_ids: list[int],
    source_selection_mode: str,
    language: str = "vi",
    force: bool = False,
) -> dict[str, Any]:
    mode = MODE_EXPLICIT if meeting_ids and source_selection_mode != MODE_ALL_READY else (
        source_selection_mode or MODE_ALL_READY
    )
    if mode == MODE_EXPLICIT and not meeting_ids:
        raise StudyValidationError("EMPTY_MEETING_IDS", "meetingIds required for EXPLICIT")

    current_hash, ready, source_rows = compute_current_source_hash(
        db,
        owner_user_id=owner_user_id,
        subject_id=subject_id,
        source_selection_mode=mode,
        meeting_ids=meeting_ids,
    )
    options = {"language": language}
    options_hash = build_options_hash(options)
    versions = synthesis_versions()
    force_token = uuid.uuid4().hex if force else None
    idem = build_idempotency_key(
        owner_user_id=owner_user_id,
        subject_id=subject_id,
        artifact_type="SYNTHESIS",
        source_hash=current_hash,
        options_hash=options_hash,
        prompt_version=versions["promptVersion"],
        schema_version=versions["schemaVersion"],
        source_selection_mode=mode,
        force_token=force_token,
    )

    existing = (
        _live_synthesis_query(db)
        .filter(SubjectSynthesis.idempotency_key == idem)
        .order_by(SubjectSynthesis.version.desc(), SubjectSynthesis.id.desc())
        .first()
    )
    if existing and not force:
        kind = _classify_prepare_row(existing)
        if kind is None:
            _soft_delete_for_retry(db, existing)
        else:
            payload = serialize_synthesis(existing)
            payload["cacheHit"] = kind == "cacheHit"
            dispatchable = [payload] if kind == "dispatchable" else []
            newly = [payload] if kind == "needsQuota" else []
            return {
                "kind": "newlyCreated" if kind == "needsQuota" else kind,
                "newlyCreated": newly,
                "cacheHits": [payload] if kind == "cacheHit" else [],
                "inFlight": [payload] if kind == "inFlight" else [],
                "dispatchableSynthesisIds": [existing.id] if kind == "dispatchable" else [],
                "dispatchableIds": [existing.id] if kind == "dispatchable" else [],
                "synthesis": payload,
            }

    latest = (
        _live_synthesis_query(db)
        .filter(
            SubjectSynthesis.owner_user_id == owner_user_id,
            SubjectSynthesis.subject_id == subject_id,
        )
        .order_by(SubjectSynthesis.version.desc(), SubjectSynthesis.id.desc())
        .first()
    )
    version = (latest.version + 1) if latest else 1
    row = SubjectSynthesis(
        subject_id=subject_id,
        owner_user_id=owner_user_id,
        status=STATUS_QUEUED,
        version=version,
        title=f"Subject synthesis v{version}",
        options_json=options,
        source_hash=current_hash,
        options_hash=options_hash,
        source_selection_mode=mode,
        subject_membership_hash=hash_membership(meeting_ids),
        prompt_version=versions["promptVersion"],
        schema_version=versions["schemaVersion"],
        idempotency_key=idem,
        generation_request_id=uuid.uuid4().hex,
        attempt_count=0,
        dispatch_attempt_count=0,
        created_at=_now(),
        updated_at=_now(),
    )
    try:
        with db.begin_nested():
            db.add(row)
            db.flush()
            for src in source_rows:
                db.add(
                    SubjectSynthesisSource(
                        synthesis_id=row.id,
                        meeting_id=src["meetingId"],
                        transcript_hash=src.get("transcriptHash"),
                        analysis_run_id=src.get("analysisRunId"),
                        analysis_version=src.get("analysisVersion"),
                        created_at=_now(),
                    )
                )
            db.flush()
    except IntegrityError:
        existing = (
            _live_synthesis_query(db)
            .filter(SubjectSynthesis.idempotency_key == idem)
            .first()
        )
        if existing is None:
            raise
        kind = _classify_prepare_row(existing) or "inFlight"
        payload = serialize_synthesis(existing)
        payload["cacheHit"] = kind == "cacheHit"
        return {
            "kind": "newlyCreated" if kind == "needsQuota" else kind,
            "newlyCreated": [payload] if kind == "needsQuota" else [],
            "cacheHits": [payload] if kind == "cacheHit" else [],
            "inFlight": [payload] if kind == "inFlight" else [],
            "dispatchableSynthesisIds": [existing.id] if kind == "dispatchable" else [],
            "dispatchableIds": [existing.id] if kind == "dispatchable" else [],
            "synthesis": payload,
        }

    # Verify the row still exists before commit (no phantom ids).
    verified = (
        _live_synthesis_query(db)
        .filter(SubjectSynthesis.id == row.id)
        .first()
    )
    if verified is None:
        raise StudyValidationError("PREPARE_PHANTOM", "Synthesis row vanished before commit")

    db.commit()
    db.refresh(verified)
    payload = serialize_synthesis(verified)
    logger.info(
        "event=SUBJECT_SYNTHESIS_REQUESTED synthesisId=%s subjectId=%s meetingCount=%s",
        verified.id,
        subject_id,
        len(source_rows),
    )
    return {
        "kind": "newlyCreated",
        "newlyCreated": [payload],
        "cacheHits": [],
        "inFlight": [],
        "dispatchableSynthesisIds": [],
        "dispatchableIds": [],
        "synthesis": payload,
    }


def prepare_artifacts(
    db: Session,
    *,
    owner_user_id: int,
    subject_id: int,
    meeting_ids: list[int],
    artifact_types: list[str],
    source_selection_mode: str,
    options: dict[str, Any] | None,
    synthesis_id: int | None = None,
    force: bool = False,
) -> dict[str, Any]:
    types = [t.upper() for t in artifact_types]
    for t in types:
        if t not in ALL_ARTIFACT_TYPES:
            raise StudyValidationError("INVALID_ARTIFACT_TYPE", t)
    if not types:
        raise StudyValidationError("EMPTY_ARTIFACT_TYPES", "artifactTypes required")

    mode = MODE_EXPLICIT if meeting_ids and source_selection_mode != MODE_ALL_READY else (
        source_selection_mode or MODE_ALL_READY
    )
    if mode == MODE_EXPLICIT and not meeting_ids:
        raise StudyValidationError("EMPTY_MEETING_IDS", "meetingIds required for EXPLICIT")

    validated_options = validate_options(options or {})
    options_hash = build_options_hash(validated_options)
    current_hash, ready, source_rows = compute_current_source_hash(
        db,
        owner_user_id=owner_user_id,
        subject_id=subject_id,
        source_selection_mode=mode,
        meeting_ids=meeting_ids,
    )

    compatible = resolve_compatible_synthesis(
        db,
        owner_user_id=owner_user_id,
        subject_id=subject_id,
        source_hash=current_hash,
        source_selection_mode=mode,
        synthesis_id=synthesis_id,
    )
    resolved_synthesis_id = int(compatible.id) if compatible is not None else None

    generation_request_id = uuid.uuid4().hex
    newly: list[dict[str, Any]] = []
    cache_hits: list[dict[str, Any]] = []
    in_flight: list[dict[str, Any]] = []
    dispatchable: list[dict[str, Any]] = []
    all_artifacts: list[dict[str, Any]] = []

    for artifact_type in types:
        prompt_version, schema_version = ARTIFACT_VERSIONS[artifact_type]
        force_token = uuid.uuid4().hex if force else None
        idem = build_idempotency_key(
            owner_user_id=owner_user_id,
            subject_id=subject_id,
            artifact_type=artifact_type,
            source_hash=current_hash,
            options_hash=options_hash,
            prompt_version=prompt_version,
            schema_version=schema_version,
            source_selection_mode=mode,
            force_token=force_token,
        )
        existing = (
            _live_artifact_query(db)
            .filter(StudyArtifact.idempotency_key == idem)
            .order_by(StudyArtifact.version.desc(), StudyArtifact.id.desc())
            .first()
        )
        if existing and not force:
            kind = _classify_prepare_row(existing)
            if kind is None:
                _soft_delete_for_retry(db, existing)
            else:
                payload = serialize_artifact(existing)
                payload["cacheHit"] = kind == "cacheHit"
                if kind == "cacheHit":
                    cache_hits.append(payload)
                elif kind == "inFlight":
                    in_flight.append(payload)
                elif kind == "dispatchable":
                    dispatchable.append(payload)
                elif kind == "needsQuota":
                    # Keep row; re-include in newlyCreated for quota reservation.
                    newly.append(payload)
                all_artifacts.append(payload)
                continue

        latest = (
            _live_artifact_query(db)
            .filter(
                StudyArtifact.owner_user_id == owner_user_id,
                StudyArtifact.subject_id == subject_id,
                StudyArtifact.artifact_type == artifact_type,
            )
            .order_by(StudyArtifact.version.desc(), StudyArtifact.id.desc())
            .first()
        )
        version = (latest.version + 1) if latest else 1
        row = StudyArtifact(
            owner_user_id=owner_user_id,
            subject_id=subject_id,
            synthesis_id=resolved_synthesis_id,
            artifact_type=artifact_type,
            status=STATUS_QUEUED,
            version=version,
            title=f"{artifact_type} v{version}",
            options_json=validated_options,
            source_hash=current_hash,
            options_hash=options_hash,
            source_selection_mode=mode,
            subject_membership_hash=hash_membership(meeting_ids),
            prompt_version=prompt_version,
            schema_version=schema_version,
            idempotency_key=idem,
            generation_request_id=generation_request_id,
            attempt_count=0,
            dispatch_attempt_count=0,
            created_at=_now(),
            updated_at=_now(),
        )
        try:
            with db.begin_nested():
                db.add(row)
                db.flush()
                for src in source_rows:
                    db.add(
                        StudyArtifactSource(
                            artifact_id=row.id,
                            meeting_id=src["meetingId"],
                            transcript_hash=src.get("transcriptHash"),
                            analysis_run_id=src.get("analysisRunId"),
                            analysis_version=src.get("analysisVersion"),
                            created_at=_now(),
                        )
                    )
                db.flush()
        except IntegrityError:
            # Roll back savepoint only — never the whole transaction.
            existing = (
                _live_artifact_query(db)
                .filter(StudyArtifact.idempotency_key == idem)
                .first()
            )
            if existing is None:
                raise
            kind = _classify_prepare_row(existing) or "inFlight"
            payload = serialize_artifact(existing)
            payload["cacheHit"] = kind == "cacheHit"
            if kind == "cacheHit":
                cache_hits.append(payload)
            elif kind == "inFlight":
                in_flight.append(payload)
            elif kind == "dispatchable":
                dispatchable.append(payload)
            elif kind == "needsQuota":
                newly.append(payload)
            else:
                in_flight.append(payload)
            all_artifacts.append(payload)
            continue

        payload = serialize_artifact(row)
        newly.append(payload)
        all_artifacts.append(payload)
        logger.info(
            "event=STUDY_ARTIFACT_REQUESTED artifactId=%s type=%s subjectId=%s",
            row.id,
            artifact_type,
            subject_id,
        )

    # Drop phantom ids that no longer exist as active rows before commit.
    returned_ids = [int(a["id"]) for a in all_artifacts if a.get("id") is not None]
    if returned_ids:
        active_ids = {
            int(r.id)
            for r in _live_artifact_query(db)
            .filter(StudyArtifact.id.in_(returned_ids))
            .all()
        }

        def _keep(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
            return [a for a in items if int(a["id"]) in active_ids]

        newly = _keep(newly)
        cache_hits = _keep(cache_hits)
        in_flight = _keep(in_flight)
        dispatchable = _keep(dispatchable)
        all_artifacts = _keep(all_artifacts)

    db.commit()
    statuses = [a["status"] for a in all_artifacts]
    dispatchable_ids = [a["id"] for a in dispatchable]
    return {
        "artifactIds": [a["id"] for a in all_artifacts],
        "newlyCreatedArtifactIds": [a["id"] for a in newly],
        "cacheHitArtifactIds": [a["id"] for a in cache_hits],
        "inFlightArtifactIds": [a["id"] for a in in_flight],
        "dispatchableArtifactIds": dispatchable_ids,
        "dispatchableIds": dispatchable_ids,
        "artifacts": all_artifacts,
        "status": aggregate_statuses(statuses),
        "generationRequestId": generation_request_id,
    }


def mark_reserved_quota_exceeded(db: Session, artifact_ids: list[int], owner_user_id: int) -> None:
    rows = (
        _live_artifact_query(db)
        .filter(
            StudyArtifact.id.in_(artifact_ids),
            StudyArtifact.owner_user_id == owner_user_id,
            StudyArtifact.status == STATUS_QUEUED,
        )
        .all()
    )
    for row in rows:
        row.status = STATUS_QUOTA_EXCEEDED
        row.error_code = "QUOTA_EXCEEDED"
        row.error_message = "Quota exceeded before generation dispatch"
        # Do NOT set quota_confirmed_at — quota was never confirmed.
        row.updated_at = _now()
    db.commit()


def mark_synthesis_quota_exceeded(db: Session, synthesis_id: int, owner_user_id: int) -> None:
    row = (
        _live_synthesis_query(db)
        .filter(
            SubjectSynthesis.id == synthesis_id,
            SubjectSynthesis.owner_user_id == owner_user_id,
        )
        .first()
    )
    if row and row.status == STATUS_QUEUED:
        row.status = STATUS_QUOTA_EXCEEDED
        row.error_code = "QUOTA_EXCEEDED"
        row.error_message = "Quota exceeded before generation dispatch"
        # Do NOT set quota_confirmed_at.
        row.updated_at = _now()
        db.commit()


def confirm_quota_for_jobs(
    db: Session,
    *,
    owner_user_id: int,
    synthesis_ids: list[int],
    artifact_ids: list[int],
) -> None:
    """Mark QUEUED rows as quota-confirmed so claim_dispatch may pick them up."""
    now = _now()
    if synthesis_ids:
        rows = (
            _live_synthesis_query(db)
            .filter(
                SubjectSynthesis.id.in_(synthesis_ids),
                SubjectSynthesis.owner_user_id == owner_user_id,
                SubjectSynthesis.status == STATUS_QUEUED,
                SubjectSynthesis.quota_confirmed_at.is_(None),
            )
            .all()
        )
        for row in rows:
            row.quota_confirmed_at = now
            row.updated_at = now
    if artifact_ids:
        rows = (
            _live_artifact_query(db)
            .filter(
                StudyArtifact.id.in_(artifact_ids),
                StudyArtifact.owner_user_id == owner_user_id,
                StudyArtifact.status == STATUS_QUEUED,
                StudyArtifact.quota_confirmed_at.is_(None),
            )
            .all()
        )
        for row in rows:
            row.quota_confirmed_at = now
            row.updated_at = now
    db.commit()


def deterministic_synthesis_task_id(synthesis_id: int, version: int) -> str:
    return f"subject-synthesis-{synthesis_id}-v{version}"


def deterministic_artifact_task_id(artifact_id: int, version: int) -> str:
    return f"study-artifact-{artifact_id}-v{version}"


def claim_dispatch_synthesis(
    db: Session,
    *,
    synthesis_id: int,
    owner_user_id: int,
    task_id: str,
) -> bool:
    settings = get_settings()
    now = _now()
    lease_cutoff = now - timedelta(seconds=settings.study_dispatch_lease_seconds)
    result = db.execute(
        text(
            """
            UPDATE subject_synthesis
            SET dispatch_requested_at = :now,
                celery_task_id = :task_id,
                dispatch_attempt_count = COALESCE(dispatch_attempt_count, 0) + 1,
                updated_at = :now
            WHERE id = :id
              AND owner_user_id = :owner
              AND deleted_at IS NULL
              AND status = 'QUEUED'
              AND quota_confirmed_at IS NOT NULL
              AND processing_started_at IS NULL
              AND (
                    dispatch_requested_at IS NULL
                    OR dispatch_requested_at < :lease_cutoff
                  )
              AND (
                    next_dispatch_retry_at IS NULL
                    OR next_dispatch_retry_at <= :now
                  )
              AND COALESCE(dispatch_attempt_count, 0) < :max_attempts
            """
        ),
        {
            "now": now,
            "task_id": task_id,
            "id": synthesis_id,
            "owner": owner_user_id,
            "lease_cutoff": lease_cutoff,
            "max_attempts": int(settings.study_dispatch_max_attempts),
        },
    )
    db.commit()
    return int(result.rowcount or 0) == 1


def claim_dispatch_artifact(
    db: Session,
    *,
    artifact_id: int,
    owner_user_id: int,
    task_id: str,
) -> bool:
    settings = get_settings()
    now = _now()
    lease_cutoff = now - timedelta(seconds=settings.study_dispatch_lease_seconds)
    result = db.execute(
        text(
            """
            UPDATE study_artifact
            SET dispatch_requested_at = :now,
                celery_task_id = :task_id,
                dispatch_attempt_count = COALESCE(dispatch_attempt_count, 0) + 1,
                updated_at = :now
            WHERE id = :id
              AND owner_user_id = :owner
              AND deleted_at IS NULL
              AND status = 'QUEUED'
              AND quota_confirmed_at IS NOT NULL
              AND processing_started_at IS NULL
              AND (
                    dispatch_requested_at IS NULL
                    OR dispatch_requested_at < :lease_cutoff
                  )
              AND (
                    next_dispatch_retry_at IS NULL
                    OR next_dispatch_retry_at <= :now
                  )
              AND COALESCE(dispatch_attempt_count, 0) < :max_attempts
            """
        ),
        {
            "now": now,
            "task_id": task_id,
            "id": artifact_id,
            "owner": owner_user_id,
            "lease_cutoff": lease_cutoff,
            "max_attempts": int(settings.study_dispatch_max_attempts),
        },
    )
    db.commit()
    return int(result.rowcount or 0) == 1


def release_dispatch_claim_synthesis(db: Session, *, synthesis_id: int, owner_user_id: int) -> None:
    db.execute(
        text(
            """
            UPDATE subject_synthesis
            SET dispatch_requested_at = NULL,
                celery_task_id = NULL,
                updated_at = :now
            WHERE id = :id
              AND owner_user_id = :owner
              AND status = 'QUEUED'
              AND processing_started_at IS NULL
            """
        ),
        {"now": _now(), "id": synthesis_id, "owner": owner_user_id},
    )
    db.commit()


def release_dispatch_claim_artifact(db: Session, *, artifact_id: int, owner_user_id: int) -> None:
    db.execute(
        text(
            """
            UPDATE study_artifact
            SET dispatch_requested_at = NULL,
                celery_task_id = NULL,
                updated_at = :now
            WHERE id = :id
              AND owner_user_id = :owner
              AND status = 'QUEUED'
              AND processing_started_at IS NULL
            """
        ),
        {"now": _now(), "id": artifact_id, "owner": owner_user_id},
    )
    db.commit()


def dispatch_study_jobs(
    db: Session,
    *,
    owner_user_id: int,
    synthesis_ids: list[int],
    artifact_ids: list[int],
) -> dict[str, Any]:
    from app.tasks import generate_study_artifact, generate_subject_synthesis

    settings = get_settings()
    dispatched_synthesis: list[int] = []
    dispatched_artifacts: list[int] = []
    idempotent_synthesis: list[int] = []
    idempotent_artifacts: list[int] = []
    failed_dispatch: list[int] = []
    task_ids: dict[str, str] = {}

    for synthesis_id in synthesis_ids:
        synth = (
            _live_synthesis_query(db)
            .filter(
                SubjectSynthesis.id == synthesis_id,
                SubjectSynthesis.owner_user_id == owner_user_id,
            )
            .first()
        )
        if synth is None or synth.status != STATUS_QUEUED:
            continue
        if synth.quota_confirmed_at is None:
            continue
        if int(synth.dispatch_attempt_count or 0) >= settings.study_dispatch_max_attempts:
            _mark_terminal_failed(
                synth,
                error_code="DISPATCH_EXHAUSTED",
                error_message="Dispatch attempts exhausted",
            )
            db.commit()
            failed_dispatch.append(int(synth.id))
            continue
        task_id = deterministic_synthesis_task_id(int(synth.id), int(synth.version))
        if not claim_dispatch_synthesis(
            db, synthesis_id=int(synth.id), owner_user_id=owner_user_id, task_id=task_id
        ):
            db.refresh(synth)
            if int(synth.dispatch_attempt_count or 0) >= settings.study_dispatch_max_attempts:
                _mark_terminal_failed(
                    synth,
                    error_code="DISPATCH_EXHAUSTED",
                    error_message="Dispatch attempts exhausted",
                )
                db.commit()
                failed_dispatch.append(int(synth.id))
                continue
            idempotent_synthesis.append(int(synth.id))
            if synth.celery_task_id:
                task_ids[f"synthesis:{synth.id}"] = synth.celery_task_id
            continue
        try:
            generate_subject_synthesis.apply_async(
                args=[int(synth.id)],
                task_id=task_id,
            )
            dispatched_synthesis.append(int(synth.id))
            task_ids[f"synthesis:{synth.id}"] = task_id
        except Exception as exc:  # noqa: BLE001
            release_dispatch_claim_synthesis(
                db, synthesis_id=int(synth.id), owner_user_id=owner_user_id
            )
            db.refresh(synth)
            _record_dispatch_broker_failure(synth, str(exc))
            db.commit()
            if synth.status == STATUS_FAILED:
                failed_dispatch.append(int(synth.id))
            raise

    for artifact_id in artifact_ids:
        art = (
            _live_artifact_query(db)
            .filter(
                StudyArtifact.id == artifact_id,
                StudyArtifact.owner_user_id == owner_user_id,
            )
            .first()
        )
        if art is None or art.status != STATUS_QUEUED:
            continue
        if art.quota_confirmed_at is None:
            continue
        if int(art.dispatch_attempt_count or 0) >= settings.study_dispatch_max_attempts:
            _mark_terminal_failed(
                art,
                error_code="DISPATCH_EXHAUSTED",
                error_message="Dispatch attempts exhausted",
            )
            db.commit()
            failed_dispatch.append(int(art.id))
            continue
        task_id = deterministic_artifact_task_id(int(art.id), int(art.version))
        if not claim_dispatch_artifact(
            db, artifact_id=int(art.id), owner_user_id=owner_user_id, task_id=task_id
        ):
            db.refresh(art)
            if int(art.dispatch_attempt_count or 0) >= settings.study_dispatch_max_attempts:
                _mark_terminal_failed(
                    art,
                    error_code="DISPATCH_EXHAUSTED",
                    error_message="Dispatch attempts exhausted",
                )
                db.commit()
                failed_dispatch.append(int(art.id))
                continue
            idempotent_artifacts.append(int(art.id))
            if art.celery_task_id:
                task_ids[f"artifact:{art.id}"] = art.celery_task_id
            continue
        try:
            generate_study_artifact.apply_async(
                args=[int(art.id)],
                task_id=task_id,
            )
            dispatched_artifacts.append(int(art.id))
            task_ids[f"artifact:{art.id}"] = task_id
        except Exception as exc:  # noqa: BLE001
            release_dispatch_claim_artifact(
                db, artifact_id=int(art.id), owner_user_id=owner_user_id
            )
            db.refresh(art)
            _record_dispatch_broker_failure(art, str(exc))
            db.commit()
            if art.status == STATUS_FAILED:
                failed_dispatch.append(int(art.id))
            raise

    return {
        "dispatchedSynthesisIds": dispatched_synthesis,
        "dispatchedArtifactIds": dispatched_artifacts,
        "idempotentSynthesisIds": idempotent_synthesis,
        "idempotentArtifactIds": idempotent_artifacts,
        "failedDispatchIds": failed_dispatch,
        "taskIds": task_ids,
    }


def claim_processing_synthesis(db: Session, synthesis_id: int) -> SubjectSynthesis | None:
    result = db.execute(
        text(
            """
            UPDATE subject_synthesis
            SET status = 'PROCESSING',
                processing_started_at = :now,
                attempt_count = COALESCE(attempt_count, 0) + 1,
                last_heartbeat_at = :now,
                updated_at = :now
            WHERE id = :id
              AND deleted_at IS NULL
              AND status = 'QUEUED'
            """
        ),
        {"now": _now(), "id": synthesis_id},
    )
    db.commit()
    if int(result.rowcount or 0) != 1:
        return None
    return _live_synthesis_query(db).filter(SubjectSynthesis.id == synthesis_id).first()


def claim_processing_artifact(db: Session, artifact_id: int) -> StudyArtifact | None:
    result = db.execute(
        text(
            """
            UPDATE study_artifact
            SET status = 'PROCESSING',
                processing_started_at = :now,
                attempt_count = COALESCE(attempt_count, 0) + 1,
                last_heartbeat_at = :now,
                updated_at = :now
            WHERE id = :id
              AND deleted_at IS NULL
              AND status = 'QUEUED'
            """
        ),
        {"now": _now(), "id": artifact_id},
    )
    db.commit()
    if int(result.rowcount or 0) != 1:
        return None
    return _live_artifact_query(db).filter(StudyArtifact.id == artifact_id).first()


def reconcile_study_generation_jobs(db: Session) -> dict[str, int]:
    """Recover stuck QUEUED/PROCESSING study jobs without infinite retries."""
    settings = get_settings()
    now = _now()
    lease_cutoff = now - timedelta(seconds=settings.study_dispatch_lease_seconds)
    processing_cutoff = now - timedelta(seconds=settings.study_processing_timeout_seconds)

    # Allow redispatch by clearing expired dispatch claims still QUEUED.
    cleared_syn = db.execute(
        text(
            """
            UPDATE subject_synthesis
            SET dispatch_requested_at = NULL,
                celery_task_id = NULL,
                updated_at = :now
            WHERE deleted_at IS NULL
              AND status = 'QUEUED'
              AND processing_started_at IS NULL
              AND dispatch_requested_at IS NOT NULL
              AND dispatch_requested_at < :lease_cutoff
            """
        ),
        {"now": now, "lease_cutoff": lease_cutoff},
    )
    cleared_art = db.execute(
        text(
            """
            UPDATE study_artifact
            SET dispatch_requested_at = NULL,
                celery_task_id = NULL,
                updated_at = :now
            WHERE deleted_at IS NULL
              AND status = 'QUEUED'
              AND processing_started_at IS NULL
              AND dispatch_requested_at IS NOT NULL
              AND dispatch_requested_at < :lease_cutoff
            """
        ),
        {"now": now, "lease_cutoff": lease_cutoff},
    )

    failed_syn = db.execute(
        text(
            """
            UPDATE subject_synthesis
            SET status = 'FAILED',
                error_code = 'PROCESSING_TIMEOUT',
                error_message = 'Processing exceeded timeout',
                updated_at = :now
            WHERE deleted_at IS NULL
              AND status = 'PROCESSING'
              AND processing_started_at IS NOT NULL
              AND processing_started_at < :cutoff
            """
        ),
        {"now": now, "cutoff": processing_cutoff},
    )
    failed_art = db.execute(
        text(
            """
            UPDATE study_artifact
            SET status = 'FAILED',
                error_code = 'PROCESSING_TIMEOUT',
                error_message = 'Processing exceeded timeout',
                updated_at = :now
            WHERE deleted_at IS NULL
              AND status = 'PROCESSING'
              AND processing_started_at IS NOT NULL
              AND processing_started_at < :cutoff
            """
        ),
        {"now": now, "cutoff": processing_cutoff},
    )
    db.commit()

    # Re-enqueue dispatchable QUEUED jobs (quota confirmed, lease null, retry due).
    from app.tasks import generate_study_artifact, generate_subject_synthesis

    enqueued_synthesis = 0
    enqueued_artifact = 0
    exhausted_synthesis = 0
    exhausted_artifact = 0

    synth_candidates = (
        _live_synthesis_query(db)
        .filter(
            SubjectSynthesis.status == STATUS_QUEUED,
            SubjectSynthesis.quota_confirmed_at.isnot(None),
            SubjectSynthesis.dispatch_requested_at.is_(None),
            SubjectSynthesis.processing_started_at.is_(None),
        )
        .all()
    )
    for synth in synth_candidates:
        next_retry = getattr(synth, "next_dispatch_retry_at", None)
        if next_retry is not None and next_retry > now:
            continue
        if int(synth.dispatch_attempt_count or 0) >= settings.study_dispatch_max_attempts:
            _mark_terminal_failed(
                synth,
                error_code="DISPATCH_EXHAUSTED",
                error_message="Dispatch attempts exhausted",
            )
            db.commit()
            exhausted_synthesis += 1
            continue
        task_id = deterministic_synthesis_task_id(int(synth.id), int(synth.version))
        if not claim_dispatch_synthesis(
            db,
            synthesis_id=int(synth.id),
            owner_user_id=int(synth.owner_user_id),
            task_id=task_id,
        ):
            db.refresh(synth)
            if int(synth.dispatch_attempt_count or 0) >= settings.study_dispatch_max_attempts:
                _mark_terminal_failed(
                    synth,
                    error_code="DISPATCH_EXHAUSTED",
                    error_message="Dispatch attempts exhausted",
                )
                db.commit()
                exhausted_synthesis += 1
            continue
        try:
            generate_subject_synthesis.apply_async(
                args=[int(synth.id)],
                task_id=task_id,
            )
            enqueued_synthesis += 1
        except Exception as exc:  # noqa: BLE001
            release_dispatch_claim_synthesis(
                db,
                synthesis_id=int(synth.id),
                owner_user_id=int(synth.owner_user_id),
            )
            db.refresh(synth)
            _record_dispatch_broker_failure(synth, str(exc))
            db.commit()
            if synth.status == STATUS_FAILED:
                exhausted_synthesis += 1

    art_candidates = (
        _live_artifact_query(db)
        .filter(
            StudyArtifact.status == STATUS_QUEUED,
            StudyArtifact.quota_confirmed_at.isnot(None),
            StudyArtifact.dispatch_requested_at.is_(None),
            StudyArtifact.processing_started_at.is_(None),
        )
        .all()
    )
    for art in art_candidates:
        next_retry = getattr(art, "next_dispatch_retry_at", None)
        if next_retry is not None and next_retry > now:
            continue
        if int(art.dispatch_attempt_count or 0) >= settings.study_dispatch_max_attempts:
            _mark_terminal_failed(
                art,
                error_code="DISPATCH_EXHAUSTED",
                error_message="Dispatch attempts exhausted",
            )
            db.commit()
            exhausted_artifact += 1
            continue
        task_id = deterministic_artifact_task_id(int(art.id), int(art.version))
        if not claim_dispatch_artifact(
            db,
            artifact_id=int(art.id),
            owner_user_id=int(art.owner_user_id),
            task_id=task_id,
        ):
            db.refresh(art)
            if int(art.dispatch_attempt_count or 0) >= settings.study_dispatch_max_attempts:
                _mark_terminal_failed(
                    art,
                    error_code="DISPATCH_EXHAUSTED",
                    error_message="Dispatch attempts exhausted",
                )
                db.commit()
                exhausted_artifact += 1
            continue
        try:
            generate_study_artifact.apply_async(
                args=[int(art.id)],
                task_id=task_id,
            )
            enqueued_artifact += 1
        except Exception as exc:  # noqa: BLE001
            release_dispatch_claim_artifact(
                db,
                artifact_id=int(art.id),
                owner_user_id=int(art.owner_user_id),
            )
            db.refresh(art)
            _record_dispatch_broker_failure(art, str(exc))
            db.commit()
            if art.status == STATUS_FAILED:
                exhausted_artifact += 1

    return {
        "clearedSynthesisDispatch": int(cleared_syn.rowcount or 0),
        "clearedArtifactDispatch": int(cleared_art.rowcount or 0),
        "failedSynthesisTimeout": int(failed_syn.rowcount or 0),
        "failedArtifactTimeout": int(failed_art.rowcount or 0),
        "enqueuedSynthesis": enqueued_synthesis,
        "enqueuedArtifact": enqueued_artifact,
        "exhaustedSynthesis": exhausted_synthesis,
        "exhaustedArtifact": exhausted_artifact,
    }


def get_synthesis_for_owner(
    db: Session,
    *,
    subject_id: int,
    owner_user_id: int,
    meeting_ids_for_stale: list[int] | None,
) -> dict[str, Any] | None:
    row = (
        _live_synthesis_query(db)
        .filter(
            SubjectSynthesis.subject_id == subject_id,
            SubjectSynthesis.owner_user_id == owner_user_id,
        )
        .order_by(SubjectSynthesis.version.desc(), SubjectSynthesis.id.desc())
        .first()
    )
    if row is None:
        return None
    stale = False
    if row.status == STATUS_COMPLETED:
        stale = evaluate_stale_for_row(
            db,
            owner_user_id=owner_user_id,
            subject_id=subject_id,
            source_selection_mode=row.source_selection_mode,
            stored_source_hash=row.source_hash,
            stored_source_meeting_ids=[s.meeting_id for s in row.sources],
            current_subject_meeting_ids=meeting_ids_for_stale,
        )
    return serialize_synthesis(row, stale=stale)


def get_artifact_for_owner(
    db: Session,
    *,
    artifact_id: int,
    owner_user_id: int,
    meeting_ids_for_stale: list[int] | None = None,
) -> dict[str, Any]:
    row = (
        _live_artifact_query(db)
        .filter(StudyArtifact.id == artifact_id, StudyArtifact.owner_user_id == owner_user_id)
        .first()
    )
    if row is None:
        raise StudyAuthorizationError("Artifact not found")
    stale = False
    if row.status == STATUS_COMPLETED and meeting_ids_for_stale is not None:
        stale = evaluate_stale_for_row(
            db,
            owner_user_id=owner_user_id,
            subject_id=row.subject_id,
            source_selection_mode=row.source_selection_mode,
            stored_source_hash=row.source_hash,
            stored_source_meeting_ids=[s.meeting_id for s in row.sources],
            current_subject_meeting_ids=meeting_ids_for_stale,
        )
    return serialize_artifact(row, stale=stale)


def list_artifacts_for_subject(
    db: Session,
    *,
    subject_id: int,
    owner_user_id: int,
    artifact_type: str | None = None,
    status: str | None = None,
    page: int = 1,
    size: int | None = None,
    sort: str = "updated_at_desc",
    meeting_ids_for_stale: list[int] | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    page = max(1, int(page or 1))
    page_size = int(size or settings.study_artifact_list_default_size)
    page_size = max(1, min(page_size, settings.study_artifact_list_max_size))

    query = _live_artifact_query(db).filter(
        StudyArtifact.subject_id == subject_id,
        StudyArtifact.owner_user_id == owner_user_id,
    )
    if artifact_type:
        query = query.filter(StudyArtifact.artifact_type == artifact_type.upper())
    if status:
        query = query.filter(StudyArtifact.status == status.upper())

    sort_key = (sort or "updated_at_desc").lower()
    if sort_key == "version_desc":
        query = query.order_by(StudyArtifact.version.desc(), StudyArtifact.id.desc())
    elif sort_key == "created_at_desc":
        query = query.order_by(StudyArtifact.created_at.desc(), StudyArtifact.id.desc())
    else:
        query = query.order_by(StudyArtifact.updated_at.desc(), StudyArtifact.id.desc())

    total = query.count()
    rows = query.offset((page - 1) * page_size).limit(page_size).all()
    items: list[dict[str, Any]] = []
    for row in rows:
        stale = False
        if row.status == STATUS_COMPLETED and meeting_ids_for_stale is not None:
            stale = evaluate_stale_for_row(
                db,
                owner_user_id=owner_user_id,
                subject_id=subject_id,
                source_selection_mode=row.source_selection_mode,
                stored_source_hash=row.source_hash,
                stored_source_meeting_ids=[s.meeting_id for s in row.sources],
                current_subject_meeting_ids=meeting_ids_for_stale,
            )
        items.append(serialize_artifact(row, stale=stale))
    return {
        "items": items,
        "page": page,
        "size": page_size,
        "total": total,
        "status": aggregate_statuses([i["status"] for i in items]),
    }


def soft_delete_artifact(db: Session, *, artifact_id: int, owner_user_id: int) -> None:
    row = (
        _live_artifact_query(db)
        .filter(StudyArtifact.id == artifact_id, StudyArtifact.owner_user_id == owner_user_id)
        .first()
    )
    if row is None:
        raise StudyAuthorizationError("Artifact not found")
    row.deleted_at = _now()
    row.updated_at = _now()
    db.commit()


def _gemini_caller():
    from app.services.analysis_factory import build_analysis_analyzer

    settings = get_settings()
    analyzer = build_analysis_analyzer(settings)

    def call_gemini(*, prompt: str, system_prompt: str, response_schema: Any = None) -> str:
        model = getattr(analyzer, "model", None) or "gemini-2.0-flash"
        return analyzer._call_gemini_text(
            prompt=prompt,
            system_prompt=system_prompt,
            model=model,
            temperature=0.2,
            response_json=True,
            response_schema=response_schema,
        )

    return call_gemini


def process_synthesis_job(db: Session, synthesis_id: int) -> None:
    row = claim_processing_synthesis(db, synthesis_id)
    if row is None:
        existing = _live_synthesis_query(db).filter(SubjectSynthesis.id == synthesis_id).first()
        if existing is None:
            return
        if existing.status in {STATUS_COMPLETED, STATUS_FAILED, STATUS_QUOTA_EXCEEDED, STATUS_PROCESSING, STATUS_STALE}:
            logger.info(
                "event=SUBJECT_SYNTHESIS_SKIPPED synthesisId=%s status=%s",
                synthesis_id,
                existing.status,
            )
            return
        return
    logger.info("event=SUBJECT_SYNTHESIS_STARTED synthesisId=%s", synthesis_id)
    meeting_ids = [s.meeting_id for s in row.sources]
    try:
        _guard_source_hash_unchanged(db, row, meeting_ids)
        # Recompute ready sources with the same membership rules as the guard.
        mode = row.source_selection_mode
        if mode == MODE_ALL_READY:
            try:
                hash_ids = fetch_subject_meeting_ids(int(row.subject_id), int(row.owner_user_id))
            except MeetingMembershipUnavailableError:
                hash_ids = list(meeting_ids)
        else:
            hash_ids = list(meeting_ids)
        _, ready, _ = compute_current_source_hash(
            db,
            owner_user_id=row.owner_user_id,
            subject_id=row.subject_id,
            source_selection_mode=mode,
            meeting_ids=hash_ids,
        )
        options = row.options_json if isinstance(row.options_json, dict) else {}
        language = str(options.get("language") or "vi")
        content = run_hierarchical_synthesis(
            ready, language=language, call_gemini=_gemini_caller()
        )
        warnings = []
        if isinstance(content, dict) and isinstance(content.get("warnings"), list):
            warnings = content.pop("warnings")
        row.content_json = content
        row.warnings_json = warnings or None
        row.status = STATUS_COMPLETED
        row.generated_at = _now()
        row.error_code = None
        row.error_message = None
        row.updated_at = _now()
        db.commit()
        logger.info("event=SUBJECT_SYNTHESIS_COMPLETED synthesisId=%s", synthesis_id)
    except StudyValidationError as exc:
        if getattr(exc, "code", None) == "SOURCE_CHANGED_AFTER_PREPARE":
            # Already marked STALE by guard.
            return
        _mark_terminal_failed(
            row,
            error_code=getattr(exc, "code", "VALIDATION_ERROR"),
            error_message=str(exc),
        )
        db.commit()
        logger.info("event=SUBJECT_SYNTHESIS_FAILED synthesisId=%s code=%s", synthesis_id, row.error_code)
        return
    except StudySourceNotReadyError as exc:
        _mark_terminal_failed(
            row,
            error_code=getattr(exc, "code", "SOURCE_MEETINGS_NOT_READY"),
            error_message=str(exc),
        )
        db.commit()
        logger.info("event=SUBJECT_SYNTHESIS_FAILED synthesisId=%s code=%s", synthesis_id, row.error_code)
        return
    except StudyTransientError:
        _requeue_for_transient_retry(row, "TRANSIENT_AI_ERROR", "Transient AI error")
        db.commit()
        raise
    except (TypeError, AttributeError, KeyError, ValueError) as exc:
        # json.JSONDecodeError is a ValueError subclass — classify before PROGRAMMING_ERROR.
        reraise = _mark_or_requeue_classified(
            db, row, exc=exc, event_name="SUBJECT_SYNTHESIS_FAILED", entity_id=synthesis_id
        )
        if reraise is not None:
            raise reraise
        return
    except Exception as exc:  # noqa: BLE001
        if _is_transient_provider_error(exc):
            _requeue_for_transient_retry(row, "TRANSIENT_AI_ERROR", str(exc)[:500])
            db.commit()
            logger.info("event=SUBJECT_SYNTHESIS_REQUEUED synthesisId=%s", synthesis_id)
            raise StudyTransientError(str(exc)) from exc
        _mark_terminal_failed(
            row,
            error_code="INTERNAL_ERROR",
            error_message=str(exc)[:500],
        )
        db.commit()
        logger.info("event=SUBJECT_SYNTHESIS_FAILED synthesisId=%s code=INTERNAL_ERROR", synthesis_id)
        return


def process_artifact_job(db: Session, artifact_id: int) -> None:
    row = claim_processing_artifact(db, artifact_id)
    if row is None:
        existing = _live_artifact_query(db).filter(StudyArtifact.id == artifact_id).first()
        if existing is None:
            return
        logger.info(
            "event=STUDY_ARTIFACT_SKIPPED artifactId=%s status=%s",
            artifact_id,
            existing.status if existing else None,
        )
        return
    logger.info(
        "event=STUDY_ARTIFACT_STARTED artifactId=%s type=%s",
        artifact_id,
        row.artifact_type,
    )
    meeting_ids = [s.meeting_id for s in row.sources]
    try:
        _guard_source_hash_unchanged(db, row, meeting_ids)
        mode = row.source_selection_mode
        if mode == MODE_ALL_READY:
            try:
                hash_ids = fetch_subject_meeting_ids(int(row.subject_id), int(row.owner_user_id))
            except MeetingMembershipUnavailableError:
                hash_ids = list(meeting_ids)
        else:
            hash_ids = list(meeting_ids)
        _, ready, _ = compute_current_source_hash(
            db,
            owner_user_id=row.owner_user_id,
            subject_id=row.subject_id,
            source_selection_mode=mode,
            meeting_ids=hash_ids,
        )
        # Prefer stored synthesis_id when still compatible; on mismatch fall back
        # to educationStudy-only generation (synthesis_id=None → auto or None).
        synthesis_content = None
        if row.synthesis_id is not None:
            try:
                compatible = resolve_compatible_synthesis(
                    db,
                    owner_user_id=int(row.owner_user_id),
                    subject_id=int(row.subject_id),
                    source_hash=row.source_hash,
                    source_selection_mode=row.source_selection_mode,
                    synthesis_id=int(row.synthesis_id),
                )
                if compatible is not None and isinstance(compatible.content_json, dict):
                    synthesis_content = compatible.content_json
            except StudyValidationError as exc:
                if exc.code == "SYNTHESIS_SOURCE_MISMATCH":
                    # Do not fail — generate from educationStudy only.
                    synthesis_content = None
                else:
                    synthesis_content = None
        else:
            synthesis_content = _load_compatible_synthesis_content(
                db,
                synthesis_id=None,
                owner_user_id=int(row.owner_user_id),
                subject_id=int(row.subject_id),
                source_hash=row.source_hash,
                source_selection_mode=row.source_selection_mode,
            )
        content = generate_artifact_content(
            row.artifact_type,
            synthesis_content=synthesis_content,
            ready_sources=ready,
            options=row.options_json or {},
            call_gemini=_gemini_caller(),
        )
        row.content_json = content
        row.status = STATUS_COMPLETED
        row.generated_at = _now()
        row.error_code = None
        row.error_message = None
        row.updated_at = _now()
        db.commit()
        logger.info(
            "event=STUDY_ARTIFACT_COMPLETED artifactId=%s type=%s",
            artifact_id,
            row.artifact_type,
        )
    except StudyValidationError as exc:
        if getattr(exc, "code", None) == "SOURCE_CHANGED_AFTER_PREPARE":
            return
        _mark_terminal_failed(
            row,
            error_code=getattr(exc, "code", "VALIDATION_ERROR"),
            error_message=str(exc),
        )
        db.commit()
        logger.info("event=STUDY_ARTIFACT_FAILED artifactId=%s code=%s", artifact_id, row.error_code)
        return
    except StudySourceNotReadyError as exc:
        _mark_terminal_failed(
            row,
            error_code=getattr(exc, "code", "SOURCE_MEETINGS_NOT_READY"),
            error_message=str(exc),
        )
        db.commit()
        logger.info("event=STUDY_ARTIFACT_FAILED artifactId=%s code=%s", artifact_id, row.error_code)
        return
    except StudyTransientError:
        _requeue_for_transient_retry(row, "TRANSIENT_AI_ERROR", "Transient AI error")
        db.commit()
        raise
    except (TypeError, AttributeError, KeyError, ValueError) as exc:
        # json.JSONDecodeError is a ValueError subclass — classify before PROGRAMMING_ERROR.
        reraise = _mark_or_requeue_classified(
            db, row, exc=exc, event_name="STUDY_ARTIFACT_FAILED", entity_id=artifact_id
        )
        if reraise is not None:
            raise reraise
        return
    except Exception as exc:  # noqa: BLE001
        if _is_transient_provider_error(exc):
            _requeue_for_transient_retry(row, "TRANSIENT_AI_ERROR", str(exc)[:500])
            db.commit()
            raise StudyTransientError(str(exc)) from exc
        _mark_terminal_failed(
            row,
            error_code="INTERNAL_ERROR",
            error_message=str(exc)[:500],
        )
        db.commit()
        logger.info("event=STUDY_ARTIFACT_FAILED artifactId=%s code=INTERNAL_ERROR", artifact_id)
        return
