import hashlib
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import MeetingAnalysisRun, Transcript
from app.services.ai_analyzer import AIAnalyzer

ANALYSIS_STATUS_ANALYZING = "ANALYZING"
ANALYSIS_STATUS_COMPLETED = "COMPLETED"
ANALYSIS_STATUS_FAILED = "FAILED"
ANALYSIS_STATUS_QUOTA_BLOCKED = "QUOTA_BLOCKED"
ANALYSIS_STATUS_RATE_LIMITED = "RATE_LIMITED"
ANALYSIS_INPUT_MODE_CANONICAL = "canonical"
ANALYSIS_INPUT_MODE_READABLE_FALLBACK = "readable_fallback"
ANALYSIS_INPUT_MODE_LEGACY_FALLBACK = "legacy_fallback"


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
    prompt_version: str,
    schema_version: str,
    provider: str,
    model: str,
    analysis_input_mode: str,
    owner_id: str | None = None,
    speaker_stabilization_version: str | None = None,
    recognition_mode: str | None = None,
    transcript_language: str | None = None,
) -> str:
    parts = [
        str(meeting_id),
        _normalize_lower(owner_id) or "",
        _normalize_lower(canonical_transcript_hash) or "",
        _clean_text(prompt_version).lower(),
        _clean_text(schema_version).lower(),
        _clean_text(provider).lower(),
        _clean_text(model).lower(),
        _clean_text(analysis_input_mode).lower(),
        _clean_text(speaker_stabilization_version).lower(),
        _clean_text(recognition_mode).lower(),
        _clean_text(transcript_language).lower(),
    ]
    return "analysis-run:" + hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


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
    requested_by: str | None = None,
    rerun_reason: str | None = None,
) -> MeetingAnalysisRun:
    payload = _json_safe(analysis_payload or {})
    if not isinstance(payload, dict):
        payload = {"value": payload}

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
    idempotency_key = build_analysis_run_idempotency_key(
        meeting_id=meeting_id,
        owner_id=owner_id,
        canonical_transcript_hash=canonical_hash,
        prompt_version=prompt_version,
        schema_version=schema_version,
        provider=provider,
        model=model,
        analysis_input_mode=input_mode,
        speaker_stabilization_version=speaker_stabilization_version,
        recognition_mode=recognition_mode,
        transcript_language=transcript_language,
    )
    now = datetime.utcnow()
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

    run.owner_id = _clean_text(owner_id) or None
    run.status = ANALYSIS_STATUS_COMPLETED
    run.provider = provider
    run.model = model
    run.prompt_version = prompt_version
    run.schema_version = schema_version
    run.canonical_transcript_hash = canonical_hash
    run.canonical_transcript_version = canonical_version
    run.speaker_stabilization_version = (
        _clean_text(speaker_stabilization_version) or None
    )
    run.recognition_mode = _normalize_lower(recognition_mode)
    run.transcript_language = _normalize_lower(transcript_language)
    run.analysis_input_mode = input_mode
    run.analysis_payload_json = payload
    run.summary = _clean_text(summary) or None
    run.error_code = None
    run.error_message = None
    run.updated_at = now
    run.completed_at = now
    run.requested_by = _clean_text(requested_by) or None
    run.rerun_reason = _clean_text(rerun_reason) or None
    return run


def latest_completed_analysis_run(
    db: Session, meeting_id: int
) -> MeetingAnalysisRun | None:
    return (
        db.query(MeetingAnalysisRun)
        .filter(
            MeetingAnalysisRun.meeting_id == meeting_id,
            MeetingAnalysisRun.status == ANALYSIS_STATUS_COMPLETED,
        )
        .order_by(MeetingAnalysisRun.completed_at.desc(), MeetingAnalysisRun.id.desc())
        .first()
    )


def analysis_run_response_metadata(run: MeetingAnalysisRun | None) -> dict[str, Any]:
    if run is None:
        return {}
    return {
        "analysisStatus": run.status,
        "provider": run.provider,
        "model": run.model,
        "promptVersion": run.prompt_version,
        "schemaVersion": run.schema_version,
        "canonicalTranscriptHash": run.canonical_transcript_hash,
        "canonicalTranscriptVersion": run.canonical_transcript_version,
        "analysisInputMode": run.analysis_input_mode,
        "lastAnalyzedAt": run.completed_at or run.updated_at,
    }
