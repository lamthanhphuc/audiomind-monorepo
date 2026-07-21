from dataclasses import dataclass
from datetime import datetime
import hashlib
from typing import Any
from uuid import uuid4

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.models import MeetingAnalysisRun, Transcript
from app.services.ai_analyzer import AIAnalyzer
from app.services.stt_persistence import validate_transcript_provenance

ANALYSIS_STATUS_ANALYZING = "ANALYZING"
ANALYSIS_STATUS_COMPLETED = "COMPLETED"
ANALYSIS_STATUS_FAILED = "FAILED"
ANALYSIS_STATUS_FAILED_RETRYABLE = "ANALYSIS_FAILED_RETRYABLE"
ANALYSIS_STATUS_QUOTA_BLOCKED = "QUOTA_BLOCKED"
ANALYSIS_STATUS_RATE_LIMITED = "RATE_LIMITED"
ANALYSIS_STATUS_NO_ANALYSIS = "NO_ANALYSIS"
ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE = "ANALYSIS_UNAVAILABLE_FOR_SCOPE"
ANALYSIS_STATUS_STALE = "STALE"
ANALYSIS_INPUT_MODE_CANONICAL = "canonical"
ANALYSIS_INPUT_MODE_READABLE_FALLBACK = "readable_fallback"
ANALYSIS_INPUT_MODE_LEGACY_FALLBACK = "legacy_fallback"
ANALYSIS_MODE_AUTO = "auto"
ANALYSIS_MODE_CACHE_ONLY = "cache_only"
ANALYSIS_MODE_FORCE = "force"
ANALYSIS_MODE_FAILED_RETRY = "failed_retry"
ANALYSIS_IN_PROGRESS_STATUSES = {ANALYSIS_STATUS_ANALYZING}
ANALYSIS_RETRYABLE_FAILURE_STATUSES = {
    ANALYSIS_STATUS_FAILED,
    ANALYSIS_STATUS_FAILED_RETRYABLE,
    ANALYSIS_STATUS_QUOTA_BLOCKED,
    ANALYSIS_STATUS_RATE_LIMITED,
}
ANALYSIS_STALE_REASON_FIELDS = (
    ("canonical_transcript_hash", "transcript_hash_changed"),
    ("canonical_transcript_version", "canonical_version_changed"),
    ("provider", "provider_changed"),
    ("model", "model_changed"),
    ("prompt_version", "prompt_version_changed"),
    ("schema_version", "schema_version_changed"),
    ("analysis_input_mode", "input_mode_changed"),
    ("speaker_stabilization_version", "speaker_stabilization_version_changed"),
)
DEFAULT_ANALYSIS_FEATURE_SET = "grouped-action-plan-v1"


@dataclass(frozen=True)
class AnalysisCacheIdentity:
    meeting_id: int
    owner_id: str | None
    canonical_transcript_hash: str | None
    canonical_transcript_version: str | None
    provider: str
    model: str
    prompt_version: str
    schema_version: str
    transcript_language: str | None
    recognition_mode: str | None
    speaker_stabilization_version: str | None
    analysis_input_mode: str
    analysis_feature_set: str | None
    recording_session_id: int | None = None
    attempt_id: int | None = None
    normalized_domain_mode: str = "it"


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_lower(value: Any) -> str | None:
    normalized = _clean_text(value).lower()
    return normalized or None


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "item"):
        try:
            return _json_safe(value.item())
        except Exception:
            pass
    return str(value)


def _analysis_timestamp(value: Any) -> str | None:
    if value is None:
        return None
    safe_value = _json_safe(value)
    return str(safe_value) if safe_value is not None else None


def _analysis_provider(analyzer: Any) -> str:
    return _normalize_lower(getattr(analyzer, "provider", None)) or "unknown"


def _analysis_model(analyzer: Any) -> str:
    return _clean_text(getattr(analyzer, "model", None)) or "unknown"


def _analysis_prompt_version(analyzer: Any, payload: dict[str, Any]) -> str:
    return (
        _clean_text(payload.get("promptVersion") or payload.get("prompt_version"))
        or _clean_text(getattr(analyzer, "PROMPT_VERSION", None))
        or AIAnalyzer.PROMPT_VERSION
    )


def _analysis_schema_version(analyzer: Any, payload: dict[str, Any]) -> str:
    return (
        _clean_text(payload.get("schemaVersion") or payload.get("schema_version"))
        or _clean_text(getattr(analyzer, "SCHEMA_VERSION", None))
        or AIAnalyzer.SCHEMA_VERSION
    )


def _analysis_feature_set(payload: dict[str, Any]) -> str | None:
    return (
        _clean_text(
            payload.get("analysisFeatureSet") or payload.get("analysis_feature_set")
        )
        or DEFAULT_ANALYSIS_FEATURE_SET
    )


def _latest_canonical_transcript(db: Session, meeting_id: int) -> Transcript | None:
    return (
        db.query(Transcript)
        .filter(
            Transcript.meeting_id == meeting_id,
            Transcript.canonical_transcript_hash.isnot(None),
        )
        .order_by(Transcript.id.desc())
        .first()
    )


def _resolve_transcript_identity(
    *,
    db: Session,
    meeting_id: int,
    fallback_transcript_hash: str | None,
    fallback_text: str | None,
) -> tuple[str | None, str | None, str]:
    canonical = _latest_canonical_transcript(db, meeting_id)
    if canonical and canonical.canonical_transcript_hash:
        return (
            _normalize_lower(canonical.canonical_transcript_hash),
            _clean_text(canonical.canonical_transcript_version) or None,
            ANALYSIS_INPUT_MODE_CANONICAL,
        )

    fallback_hash = _normalize_lower(fallback_transcript_hash)
    if fallback_hash:
        return fallback_hash, None, ANALYSIS_INPUT_MODE_READABLE_FALLBACK

    fallback_body = _clean_text(fallback_text)
    if fallback_body:
        return (
            hashlib.sha256(fallback_body.encode("utf-8")).hexdigest(),
            None,
            ANALYSIS_INPUT_MODE_READABLE_FALLBACK,
        )
    return None, None, ANALYSIS_INPUT_MODE_LEGACY_FALLBACK


def build_analysis_run_idempotency_key(
    *,
    meeting_id: int,
    canonical_transcript_hash: str | None,
    canonical_transcript_version: str | None = None,
    prompt_version: str,
    schema_version: str,
    provider: str,
    model: str,
    analysis_input_mode: str,
    owner_id: str | None = None,
    speaker_stabilization_version: str | None = None,
    recognition_mode: str | None = None,
    transcript_language: str | None = None,
    analysis_feature_set: str | None = None,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
    normalized_domain_mode: str = "it",
) -> str:
    parts = [
        str(meeting_id),
        _normalize_lower(owner_id) or "",
        _normalize_lower(canonical_transcript_hash) or "",
        _clean_text(canonical_transcript_version).lower(),
        _clean_text(prompt_version).lower(),
        _clean_text(schema_version).lower(),
        _clean_text(provider).lower(),
        _clean_text(model).lower(),
        _clean_text(analysis_input_mode).lower(),
        _clean_text(speaker_stabilization_version).lower(),
        _clean_text(recognition_mode).lower(),
        _clean_text(transcript_language).lower(),
        _clean_text(analysis_feature_set).lower(),
        _clean_text(normalized_domain_mode).lower(),
        "" if recording_session_id is None else str(recording_session_id),
        "" if attempt_id is None else str(attempt_id),
    ]
    return "analysis-run:" + hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def build_analysis_run_idempotency_key_for_identity(
    identity: AnalysisCacheIdentity,
) -> str:
    return build_analysis_run_idempotency_key(
        meeting_id=identity.meeting_id,
        owner_id=identity.owner_id,
        canonical_transcript_hash=identity.canonical_transcript_hash,
        canonical_transcript_version=identity.canonical_transcript_version,
        prompt_version=identity.prompt_version,
        schema_version=identity.schema_version,
        provider=identity.provider,
        model=identity.model,
        analysis_input_mode=identity.analysis_input_mode,
        speaker_stabilization_version=identity.speaker_stabilization_version,
        recognition_mode=identity.recognition_mode,
        transcript_language=identity.transcript_language,
        analysis_feature_set=identity.analysis_feature_set,
        recording_session_id=identity.recording_session_id,
        attempt_id=identity.attempt_id,
        normalized_domain_mode=identity.normalized_domain_mode,
    )


def normalize_analysis_mode(value: Any) -> str:
    mode = _clean_text(value).lower()
    if mode in {
        ANALYSIS_MODE_AUTO,
        ANALYSIS_MODE_CACHE_ONLY,
        ANALYSIS_MODE_FORCE,
        ANALYSIS_MODE_FAILED_RETRY,
    }:
        return mode
    return ANALYSIS_MODE_AUTO


def build_analysis_cache_identity(
    *,
    db: Session,
    meeting_id: int,
    analyzer: Any,
    fallback_transcript_hash: str | None,
    fallback_text: str | None,
    analysis_payload: dict[str, Any] | None = None,
    owner_id: str | None = None,
    speaker_stabilization_version: str | None = None,
    recognition_mode: str | None = None,
    transcript_language: str | None = None,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
    normalized_domain_mode: str = "it",
) -> AnalysisCacheIdentity:
    provenance = validate_transcript_provenance(recording_session_id, attempt_id)
    payload = analysis_payload or {}
    provider = _analysis_provider(analyzer)
    model = _analysis_model(analyzer)
    prompt_version = _analysis_prompt_version(analyzer, payload)
    schema_version = _analysis_schema_version(analyzer, payload)
    canonical_hash, canonical_version, input_mode = _resolve_transcript_identity(
        db=db,
        meeting_id=meeting_id,
        fallback_transcript_hash=fallback_transcript_hash,
        fallback_text=fallback_text,
    )
    return AnalysisCacheIdentity(
        meeting_id=meeting_id,
        owner_id=_clean_text(owner_id) or None,
        canonical_transcript_hash=canonical_hash,
        canonical_transcript_version=_clean_text(canonical_version) or None,
        provider=provider,
        model=model,
        prompt_version=prompt_version,
        schema_version=schema_version,
        transcript_language=_normalize_lower(transcript_language),
        recognition_mode=_normalize_lower(recognition_mode),
        speaker_stabilization_version=_clean_text(speaker_stabilization_version)
        or None,
        analysis_input_mode=input_mode,
        analysis_feature_set=_analysis_feature_set(payload),
        recording_session_id=provenance.recording_session_id,
        attempt_id=provenance.attempt_id,
        normalized_domain_mode=_clean_text(normalized_domain_mode).lower() or "it",
    )


def _nullable_match(column: Any, value: str | None) -> Any:
    if value is None:
        return column.is_(None)
    return column == value


def find_completed_analysis_run_for_identity(
    db: Session, identity: AnalysisCacheIdentity
) -> MeetingAnalysisRun | None:
    idempotency_key = build_analysis_run_idempotency_key_for_identity(identity)
    return (
        db.query(MeetingAnalysisRun)
        .filter(
            MeetingAnalysisRun.status == ANALYSIS_STATUS_COMPLETED,
            MeetingAnalysisRun.idempotency_key == idempotency_key,
        )
        .order_by(MeetingAnalysisRun.completed_at.desc(), MeetingAnalysisRun.id.desc())
        .first()
    )


def _identity_filters(identity: AnalysisCacheIdentity) -> list[Any]:
    return [
        MeetingAnalysisRun.meeting_id == identity.meeting_id,
        _nullable_match(MeetingAnalysisRun.owner_id, identity.owner_id),
        _nullable_match(
            MeetingAnalysisRun.canonical_transcript_hash,
            identity.canonical_transcript_hash,
        ),
        _nullable_match(
            MeetingAnalysisRun.canonical_transcript_version,
            identity.canonical_transcript_version,
        ),
        MeetingAnalysisRun.provider == identity.provider,
        MeetingAnalysisRun.model == identity.model,
        MeetingAnalysisRun.prompt_version == identity.prompt_version,
        MeetingAnalysisRun.schema_version == identity.schema_version,
        _nullable_match(
            MeetingAnalysisRun.speaker_stabilization_version,
            identity.speaker_stabilization_version,
        ),
        _nullable_match(
            MeetingAnalysisRun.recognition_mode,
            identity.recognition_mode,
        ),
        _nullable_match(
            MeetingAnalysisRun.transcript_language,
            identity.transcript_language,
        ),
        MeetingAnalysisRun.analysis_input_mode == identity.analysis_input_mode,
        _nullable_match(
            MeetingAnalysisRun.recording_session_id,
            identity.recording_session_id,
        ),
        _nullable_match(MeetingAnalysisRun.attempt_id, identity.attempt_id),
    ]


def find_latest_analysis_run_for_identity(
    db: Session, identity: AnalysisCacheIdentity
) -> MeetingAnalysisRun | None:
    candidates = (
        db.query(MeetingAnalysisRun)
        .filter(and_(*_identity_filters(identity)))
        .order_by(MeetingAnalysisRun.updated_at.desc(), MeetingAnalysisRun.id.desc())
        .all()
    )
    return next(
        (
            run
            for run in candidates
            if _run_analysis_feature_set(run) == identity.analysis_feature_set
        ),
        None,
    )


def find_in_progress_analysis_run_for_identity(
    db: Session, identity: AnalysisCacheIdentity
) -> MeetingAnalysisRun | None:
    candidates = (
        db.query(MeetingAnalysisRun)
        .filter(
            and_(
                *_identity_filters(identity),
                MeetingAnalysisRun.status.in_(ANALYSIS_IN_PROGRESS_STATUSES),
            )
        )
        .order_by(MeetingAnalysisRun.updated_at.desc(), MeetingAnalysisRun.id.desc())
        .all()
    )
    return next(
        (
            run
            for run in candidates
            if _run_analysis_feature_set(run) == identity.analysis_feature_set
        ),
        None,
    )


def latest_analysis_run_for_meeting(
    db: Session, meeting_id: int
) -> MeetingAnalysisRun | None:
    return (
        db.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .order_by(MeetingAnalysisRun.updated_at.desc(), MeetingAnalysisRun.id.desc())
        .first()
    )


def _run_value(run: MeetingAnalysisRun, field_name: str) -> Any:
    return getattr(run, field_name, None)


def stale_reason_for_identity(
    identity: AnalysisCacheIdentity, run: MeetingAnalysisRun | None
) -> str | None:
    if run is None:
        return None
    for field_name, reason in ANALYSIS_STALE_REASON_FIELDS:
        if _run_value(run, field_name) != getattr(identity, field_name):
            return reason
    if _run_value(run, "recording_session_id") != identity.recording_session_id:
        return "recording_session_changed"
    if _run_value(run, "attempt_id") != identity.attempt_id:
        return "attempt_changed"
    if (
        run.owner_id != identity.owner_id
        or run.recognition_mode != identity.recognition_mode
        or run.transcript_language != identity.transcript_language
    ):
        return "identity_mismatch"
    if _run_analysis_feature_set(run) != identity.analysis_feature_set:
        return "analysis_feature_set_changed"
    return None


def analysis_miss_response_metadata(
    db: Session, identity: AnalysisCacheIdentity
) -> dict[str, Any]:
    latest_run = latest_completed_analysis_run(
        db,
        identity.meeting_id,
        identity.recording_session_id,
        identity.attempt_id,
    )
    stale_reason = stale_reason_for_identity(identity, latest_run)
    if identity.recording_session_id is not None and latest_run is None:
        status = ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE
    elif stale_reason:
        status = ANALYSIS_STATUS_STALE
    else:
        status = ANALYSIS_STATUS_NO_ANALYSIS
    metadata = {
        "analysisStatus": status,
        "cacheHit": False,
        "stale": bool(stale_reason),
        "staleReason": stale_reason,
        "provider": identity.provider,
        "model": identity.model,
        "promptVersion": identity.prompt_version,
        "schemaVersion": identity.schema_version,
        "analysisFeatureSet": identity.analysis_feature_set,
        "canonicalTranscriptHash": identity.canonical_transcript_hash,
        "canonicalTranscriptVersion": identity.canonical_transcript_version,
        "analysisInputMode": identity.analysis_input_mode,
        "lastAnalyzedAt": _analysis_timestamp(
            (latest_run.completed_at or latest_run.updated_at) if latest_run else None
        ),
    }
    return metadata


def _apply_identity_to_run(
    run: MeetingAnalysisRun,
    identity: AnalysisCacheIdentity,
) -> None:
    run.owner_id = identity.owner_id
    run.provider = identity.provider
    run.model = identity.model
    run.prompt_version = identity.prompt_version
    run.schema_version = identity.schema_version
    run.canonical_transcript_hash = identity.canonical_transcript_hash
    run.canonical_transcript_version = identity.canonical_transcript_version
    run.speaker_stabilization_version = identity.speaker_stabilization_version
    run.recognition_mode = identity.recognition_mode
    run.transcript_language = identity.transcript_language
    run.analysis_input_mode = identity.analysis_input_mode
    run.recording_session_id = identity.recording_session_id
    run.attempt_id = identity.attempt_id


def begin_analysis_run(
    *,
    db: Session,
    identity: AnalysisCacheIdentity,
    mode: str = ANALYSIS_MODE_AUTO,
    requested_by: str | None = None,
    rerun_reason: str | None = None,
) -> tuple[MeetingAnalysisRun, bool]:
    normalized_mode = normalize_analysis_mode(mode)
    existing_in_progress = find_in_progress_analysis_run_for_identity(db, identity)
    if existing_in_progress is not None:
        return existing_in_progress, False

    if normalized_mode == ANALYSIS_MODE_FORCE:
        idempotency_key = (
            f"{build_analysis_run_idempotency_key_for_identity(identity)}:"
            f"force:{uuid4().hex}"
        )
        run = None
    else:
        idempotency_key = build_analysis_run_idempotency_key_for_identity(identity)
        run = (
            db.query(MeetingAnalysisRun)
            .filter(MeetingAnalysisRun.idempotency_key == idempotency_key)
            .first()
        )

    now = datetime.utcnow()
    if run is None:
        run = MeetingAnalysisRun(
            meeting_id=identity.meeting_id,
            idempotency_key=idempotency_key,
            created_at=now,
        )
        db.add(run)

    _apply_identity_to_run(run, identity)
    run.status = ANALYSIS_STATUS_ANALYZING
    run.analysis_payload_json = _analysis_feature_set_payload(identity)
    run.summary = None
    run.error_code = None
    run.error_message = None
    run.updated_at = now
    run.completed_at = None
    run.requested_by = _clean_text(requested_by) or None
    run.rerun_reason = _clean_text(rerun_reason) or None
    return run, True


def persist_completed_analysis_run(
    *,
    db: Session,
    meeting_id: int,
    analyzer: Any,
    analysis_payload: dict[str, Any],
    summary: str | None,
    fallback_transcript_hash: str | None,
    fallback_text: str | None,
    owner_id: str | None = None,
    speaker_stabilization_version: str | None = None,
    recognition_mode: str | None = None,
    transcript_language: str | None = None,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
    requested_by: str | None = None,
    rerun_reason: str | None = None,
    run: MeetingAnalysisRun | None = None,
    normalized_domain_mode: str = "it",
) -> MeetingAnalysisRun:
    if run is not None:
        recording_session_id = run.recording_session_id
        attempt_id = run.attempt_id

    payload = _json_safe(analysis_payload or {})
    if not isinstance(payload, dict):
        payload = {"value": payload}

    identity = build_analysis_cache_identity(
        db=db,
        meeting_id=meeting_id,
        analyzer=analyzer,
        fallback_transcript_hash=fallback_transcript_hash,
        fallback_text=fallback_text,
        analysis_payload=payload,
        owner_id=owner_id,
        speaker_stabilization_version=speaker_stabilization_version,
        recognition_mode=recognition_mode,
        transcript_language=transcript_language,
        recording_session_id=recording_session_id,
        attempt_id=attempt_id,
        normalized_domain_mode=normalized_domain_mode,
    )
    if identity.analysis_feature_set and not (
        payload.get("analysisFeatureSet") or payload.get("analysis_feature_set")
    ):
        payload["analysisFeatureSet"] = identity.analysis_feature_set
    idempotency_key = build_analysis_run_idempotency_key_for_identity(identity)
    now = datetime.utcnow()
    if run is None:
        run = (
            db.query(MeetingAnalysisRun)
            .filter(MeetingAnalysisRun.idempotency_key == idempotency_key)
            .first()
        )
    if run is None:
        run = MeetingAnalysisRun(
            meeting_id=meeting_id,
            idempotency_key=idempotency_key,
            created_at=now,
        )
        db.add(run)

    _apply_identity_to_run(run, identity)
    run.status = ANALYSIS_STATUS_COMPLETED
    run.analysis_payload_json = payload
    run.summary = _clean_text(summary) or None
    run.error_code = None
    run.error_message = None
    run.updated_at = now
    run.completed_at = now
    run.requested_by = _clean_text(requested_by) or None
    run.rerun_reason = _clean_text(rerun_reason) or None
    return run


def mark_analysis_run_failed(
    *,
    run: MeetingAnalysisRun | None,
    status: str = ANALYSIS_STATUS_FAILED,
    error_code: str | None = None,
    error_message: str | None = None,
    analysis_retry_count: int | None = None,
    analysis_next_retry_at: datetime | None = None,
    analysis_trace_id: str | None = None,
    analysis_provider_alias: str | None = None,
    analysis_input_hash: str | None = None,
) -> MeetingAnalysisRun | None:
    if run is None:
        return None
    normalized_status = _clean_text(status).upper()
    allowed_statuses = ANALYSIS_RETRYABLE_FAILURE_STATUSES | {
        ANALYSIS_STATUS_FAILED_RETRYABLE,
        ANALYSIS_STATUS_NO_ANALYSIS,
        ANALYSIS_STATUS_STALE,
    }
    if normalized_status not in allowed_statuses:
        normalized_status = ANALYSIS_STATUS_FAILED
    run.status = normalized_status
    run.error_code = _clean_text(error_code) or None
    run.error_message = _clean_text(error_message)[:1000] or None
    run.updated_at = datetime.utcnow()
    run.analysis_last_attempt_at = datetime.utcnow()
    run.completed_at = None
    if analysis_retry_count is not None:
        run.analysis_retry_count = max(0, int(analysis_retry_count))
    if analysis_next_retry_at is not None:
        run.analysis_next_retry_at = analysis_next_retry_at
    if analysis_trace_id:
        run.analysis_trace_id = _clean_text(analysis_trace_id) or None
    if analysis_provider_alias:
        run.analysis_provider_alias = _clean_text(analysis_provider_alias)[:32] or None
    if analysis_input_hash:
        run.analysis_input_hash = _clean_text(analysis_input_hash)[:64] or None
    return run


def mark_analysis_run_skipped_short(
    *,
    run: MeetingAnalysisRun | None,
    error_code: str = "ANALYSIS_SKIPPED_SHORT_TRANSCRIPT",
    error_message: str | None = None,
    analysis_input_hash: str | None = None,
) -> MeetingAnalysisRun | None:
    return mark_analysis_run_failed(
        run=run,
        status=ANALYSIS_STATUS_NO_ANALYSIS,
        error_code=error_code,
        error_message=error_message,
        analysis_input_hash=analysis_input_hash,
    )


def latest_completed_analysis_run(
    db: Session,
    meeting_id: int,
    recording_session_id: int | None = None,
    attempt_id: int | None = None,
) -> MeetingAnalysisRun | None:
    validate_transcript_provenance(recording_session_id, attempt_id)
    query = db.query(MeetingAnalysisRun).filter(
        MeetingAnalysisRun.meeting_id == meeting_id,
        MeetingAnalysisRun.status == ANALYSIS_STATUS_COMPLETED,
    )
    if recording_session_id is None:
        query = query.filter(
            MeetingAnalysisRun.recording_session_id.is_(None),
            MeetingAnalysisRun.attempt_id.is_(None),
        )
    else:
        query = query.filter(
            MeetingAnalysisRun.recording_session_id == recording_session_id,
            MeetingAnalysisRun.attempt_id == attempt_id,
        )
    return query.order_by(
        MeetingAnalysisRun.completed_at.desc(),
        MeetingAnalysisRun.id.desc(),
    ).first()


def analysis_payload_from_run(
    run: MeetingAnalysisRun | None, *, cache_hit: bool = True
) -> dict[str, Any]:
    if run is None:
        return {}
    payload = (
        run.analysis_payload_json if isinstance(run.analysis_payload_json, dict) else {}
    )
    result = dict(payload)
    if run.summary and not result.get("summary"):
        result["summary"] = run.summary
    result.update(analysis_run_response_metadata(run, cache_hit=cache_hit))
    return result


def analysis_run_response_metadata(
    run: MeetingAnalysisRun | None, *, cache_hit: bool | None = None
) -> dict[str, Any]:
    if run is None:
        return {}
    metadata = {
        "analysisStatus": run.status,
        "stale": False,
        "staleReason": None,
        "provider": run.provider,
        "model": run.model,
        "promptVersion": run.prompt_version,
        "schemaVersion": run.schema_version,
        "analysisFeatureSet": _run_analysis_feature_set(run),
        "canonicalTranscriptHash": run.canonical_transcript_hash,
        "canonicalTranscriptVersion": run.canonical_transcript_version,
        "analysisInputMode": run.analysis_input_mode,
        "lastAnalyzedAt": _analysis_timestamp(run.completed_at or run.updated_at),
    }
    if cache_hit is not None:
        metadata["cacheHit"] = cache_hit
    if run.error_code:
        metadata["errorCode"] = run.error_code
    if run.error_message:
        metadata["errorMessage"] = run.error_message
    if run.recording_session_id is not None:
        metadata["recordingSessionId"] = int(run.recording_session_id)
    if run.attempt_id is not None:
        metadata["attemptId"] = int(run.attempt_id)
    if (
        run.status in ANALYSIS_RETRYABLE_FAILURE_STATUSES
        or run.status == ANALYSIS_STATUS_FAILED_RETRYABLE
    ):
        metadata["retryable"] = True
        metadata["analysisRetryCount"] = int(
            getattr(run, "analysis_retry_count", 0) or 0
        )
        if getattr(run, "analysis_next_retry_at", None):
            metadata["analysisNextRetryAt"] = _analysis_timestamp(
                run.analysis_next_retry_at
            )
        if getattr(run, "analysis_trace_id", None):
            metadata["analysisTraceId"] = run.analysis_trace_id
        if getattr(run, "analysis_provider_alias", None):
            metadata["analysisProviderAlias"] = run.analysis_provider_alias
        if getattr(run, "analysis_input_hash", None):
            metadata["analysisInputHash"] = run.analysis_input_hash
        max_attempts = 4
        metadata["retryExhausted"] = metadata["analysisRetryCount"] >= max_attempts
    if run.status == ANALYSIS_STATUS_NO_ANALYSIS and run.error_code:
        metadata["retryable"] = False
    return metadata


def _run_analysis_feature_set(run: MeetingAnalysisRun | None) -> str | None:
    if run is None:
        return None
    payload = (
        run.analysis_payload_json if isinstance(run.analysis_payload_json, dict) else {}
    )
    return (
        _clean_text(
            payload.get("analysisFeatureSet") or payload.get("analysis_feature_set")
        )
        or None
    )


def _analysis_feature_set_payload(
    identity: AnalysisCacheIdentity,
) -> dict[str, Any] | None:
    feature_set = _clean_text(identity.analysis_feature_set)
    if not feature_set:
        return None
    return {"analysisFeatureSet": feature_set}
