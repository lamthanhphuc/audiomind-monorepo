"""Prepare / dispatch / CRUD for subject synthesis and study artifacts."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

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
    STATUS_QUOTA_EXCEEDED,
    STATUS_STALE,
    SYNTHESIS_PROMPT_VERSION,
    SYNTHESIS_SCHEMA_VERSION,
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
    return {
        "id": row.id,
        "subjectId": row.subject_id,
        "ownerUserId": row.owner_user_id,
        "status": status,
        "version": row.version,
        "title": row.title,
        "content": row.content_json,
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
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    resolved = resolve_study_sources(db, owner_user_id=owner_user_id, meeting_ids=meeting_ids)
    if source_selection_mode == MODE_ALL_READY:
        ready = [r for r in resolved if r.get("ready")]
    else:
        not_ready = [int(r["meetingId"]) for r in resolved if not r.get("ready")]
        if not_ready:
            raise StudySourceNotReadyError(not_ready)
        ready = [r for r in resolved if r.get("ready")]
    if not ready:
        raise StudySourceNotReadyError([int(m) for m in meeting_ids])
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
        kind = "inFlight" if existing.status in IN_FLIGHT else "cacheHit"
        payload = serialize_synthesis(existing)
        payload["cacheHit"] = kind == "cacheHit"
        return {
            "kind": kind,
            "newlyCreated": [],
            "cacheHits": [payload] if kind == "cacheHit" else [],
            "inFlight": [payload] if kind == "inFlight" else [],
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
        source_hash=current_hash,
        options_hash=options_hash,
        source_selection_mode=mode,
        prompt_version=versions["promptVersion"],
        schema_version=versions["schemaVersion"],
        idempotency_key=idem,
        generation_request_id=uuid.uuid4().hex,
        created_at=_now(),
        updated_at=_now(),
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = (
            _live_synthesis_query(db)
            .filter(SubjectSynthesis.idempotency_key == idem)
            .first()
        )
        if existing is None:
            raise
        payload = serialize_synthesis(existing)
        kind = "inFlight" if existing.status in IN_FLIGHT else "cacheHit"
        payload["cacheHit"] = kind == "cacheHit"
        return {
            "kind": kind,
            "newlyCreated": [],
            "cacheHits": [payload] if kind == "cacheHit" else [],
            "inFlight": [payload] if kind == "inFlight" else [],
            "synthesis": payload,
        }

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
    db.commit()
    db.refresh(row)
    payload = serialize_synthesis(row)
    logger.info(
        "event=SUBJECT_SYNTHESIS_REQUESTED synthesisId=%s subjectId=%s meetingCount=%s",
        row.id,
        subject_id,
        len(source_rows),
    )
    return {
        "kind": "newlyCreated",
        "newlyCreated": [payload],
        "cacheHits": [],
        "inFlight": [],
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

    generation_request_id = uuid.uuid4().hex
    newly: list[dict[str, Any]] = []
    cache_hits: list[dict[str, Any]] = []
    in_flight: list[dict[str, Any]] = []
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
            payload = serialize_artifact(existing)
            if existing.status in IN_FLIGHT:
                payload["cacheHit"] = False
                in_flight.append(payload)
            else:
                payload["cacheHit"] = True
                cache_hits.append(payload)
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
            synthesis_id=synthesis_id,
            artifact_type=artifact_type,
            status=STATUS_QUEUED,
            version=version,
            title=f"{artifact_type} v{version}",
            options_json=validated_options,
            source_hash=current_hash,
            options_hash=options_hash,
            source_selection_mode=mode,
            prompt_version=prompt_version,
            schema_version=schema_version,
            idempotency_key=idem,
            generation_request_id=generation_request_id,
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(row)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            existing = (
                _live_artifact_query(db)
                .filter(StudyArtifact.idempotency_key == idem)
                .first()
            )
            if existing is None:
                raise
            payload = serialize_artifact(existing)
            if existing.status in IN_FLIGHT:
                in_flight.append(payload)
            else:
                payload["cacheHit"] = True
                cache_hits.append(payload)
            all_artifacts.append(payload)
            continue

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
        payload = serialize_artifact(row)
        newly.append(payload)
        all_artifacts.append(payload)
        logger.info(
            "event=STUDY_ARTIFACT_REQUESTED artifactId=%s type=%s subjectId=%s",
            row.id,
            artifact_type,
            subject_id,
        )

    db.commit()
    statuses = [a["status"] for a in all_artifacts]
    return {
        "artifactIds": [a["id"] for a in all_artifacts],
        "newlyCreatedArtifactIds": [a["id"] for a in newly],
        "cacheHitArtifactIds": [a["id"] for a in cache_hits],
        "inFlightArtifactIds": [a["id"] for a in in_flight],
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
        row.updated_at = _now()
        db.commit()


def get_synthesis_for_owner(
    db: Session, *, subject_id: int, owner_user_id: int, meeting_ids_for_stale: list[int]
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
    if row.status == STATUS_COMPLETED and meeting_ids_for_stale:
        try:
            current_hash, _, _ = compute_current_source_hash(
                db,
                owner_user_id=owner_user_id,
                subject_id=subject_id,
                source_selection_mode=row.source_selection_mode,
                meeting_ids=(
                    meeting_ids_for_stale
                    if row.source_selection_mode == MODE_ALL_READY
                    else [s.meeting_id for s in row.sources]
                ),
            )
            stale = is_stale_against_current(
                stored_source_hash=row.source_hash, current_source_hash=current_hash
            )
        except StudySourceNotReadyError:
            stale = True
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
        try:
            ids = (
                meeting_ids_for_stale
                if row.source_selection_mode == MODE_ALL_READY
                else [s.meeting_id for s in row.sources]
            )
            current_hash, _, _ = compute_current_source_hash(
                db,
                owner_user_id=owner_user_id,
                subject_id=row.subject_id,
                source_selection_mode=row.source_selection_mode,
                meeting_ids=ids,
            )
            stale = is_stale_against_current(
                stored_source_hash=row.source_hash, current_source_hash=current_hash
            )
        except StudySourceNotReadyError:
            stale = True
    return serialize_artifact(row, stale=stale)


def list_artifacts_for_subject(
    db: Session,
    *,
    subject_id: int,
    owner_user_id: int,
    artifact_type: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    query = _live_artifact_query(db).filter(
        StudyArtifact.subject_id == subject_id,
        StudyArtifact.owner_user_id == owner_user_id,
    )
    if artifact_type:
        query = query.filter(StudyArtifact.artifact_type == artifact_type.upper())
    if status:
        query = query.filter(StudyArtifact.status == status.upper())
    rows = query.order_by(StudyArtifact.updated_at.desc(), StudyArtifact.id.desc()).all()
    return [serialize_artifact(r) for r in rows]


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
    row = _live_synthesis_query(db).filter(SubjectSynthesis.id == synthesis_id).first()
    if row is None:
        return
    row.status = STATUS_PROCESSING
    row.updated_at = _now()
    db.commit()
    logger.info("event=SUBJECT_SYNTHESIS_STARTED synthesisId=%s", synthesis_id)
    meeting_ids = [s.meeting_id for s in row.sources]
    try:
        _, ready, _ = compute_current_source_hash(
            db,
            owner_user_id=row.owner_user_id,
            subject_id=row.subject_id,
            source_selection_mode=row.source_selection_mode,
            meeting_ids=meeting_ids,
        )
        language = "vi"
        content = run_hierarchical_synthesis(
            ready, language=language, call_gemini=_gemini_caller()
        )
        row.content_json = content
        row.status = STATUS_COMPLETED
        row.generated_at = _now()
        row.error_code = None
        row.error_message = None
        row.updated_at = _now()
        db.commit()
        logger.info("event=SUBJECT_SYNTHESIS_COMPLETED synthesisId=%s", synthesis_id)
    except (StudyValidationError, StudySourceNotReadyError) as exc:
        row.status = STATUS_FAILED
        row.error_code = getattr(exc, "code", "VALIDATION_ERROR")
        row.error_message = str(exc)
        row.updated_at = _now()
        db.commit()
        logger.info("event=SUBJECT_SYNTHESIS_FAILED synthesisId=%s code=%s", synthesis_id, row.error_code)
        return
    except StudyTransientError:
        row.status = STATUS_FAILED
        row.error_code = "TRANSIENT_AI_ERROR"
        row.error_message = "Transient AI error"
        row.updated_at = _now()
        db.commit()
        raise
    except Exception as exc:  # noqa: BLE001
        row.status = STATUS_FAILED
        row.error_code = "SYNTHESIS_FAILED"
        row.error_message = str(exc)[:500]
        row.updated_at = _now()
        db.commit()
        logger.info("event=SUBJECT_SYNTHESIS_FAILED synthesisId=%s", synthesis_id)
        raise StudyTransientError(str(exc)) from exc


def process_artifact_job(db: Session, artifact_id: int) -> None:
    row = _live_artifact_query(db).filter(StudyArtifact.id == artifact_id).first()
    if row is None:
        return
    row.status = STATUS_PROCESSING
    row.updated_at = _now()
    db.commit()
    logger.info(
        "event=STUDY_ARTIFACT_STARTED artifactId=%s type=%s",
        artifact_id,
        row.artifact_type,
    )
    meeting_ids = [s.meeting_id for s in row.sources]
    try:
        _, ready, _ = compute_current_source_hash(
            db,
            owner_user_id=row.owner_user_id,
            subject_id=row.subject_id,
            source_selection_mode=row.source_selection_mode,
            meeting_ids=meeting_ids,
        )
        synthesis_content = None
        if row.synthesis_id:
            synth = (
                _live_synthesis_query(db)
                .filter(SubjectSynthesis.id == row.synthesis_id)
                .first()
            )
            if synth and isinstance(synth.content_json, dict):
                synthesis_content = synth.content_json
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
    except (StudyValidationError, StudySourceNotReadyError) as exc:
        row.status = STATUS_FAILED
        row.error_code = getattr(exc, "code", "VALIDATION_ERROR")
        row.error_message = str(exc)
        row.updated_at = _now()
        db.commit()
        logger.info("event=STUDY_ARTIFACT_FAILED artifactId=%s code=%s", artifact_id, row.error_code)
        # Do not retry validation
        return
    except StudyTransientError:
        row.status = STATUS_FAILED
        row.error_code = "TRANSIENT_AI_ERROR"
        row.error_message = "Transient AI error"
        row.updated_at = _now()
        db.commit()
        raise
    except Exception as exc:  # noqa: BLE001
        row.status = STATUS_FAILED
        row.error_code = "ARTIFACT_FAILED"
        row.error_message = str(exc)[:500]
        row.updated_at = _now()
        db.commit()
        raise StudyTransientError(str(exc)) from exc
