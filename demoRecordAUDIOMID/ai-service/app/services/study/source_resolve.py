"""Bulk resolve education study sources for subject synthesis / artifacts."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.services.analysis_runs import (
    ANALYSIS_STATUS_COMPLETED,
    analysis_payload_from_run,
    latest_completed_analysis_run,
)
from app.services.education_analysis import (
    extract_education_study_raw,
    normalize_education_study,
)
from app.services.segment_identity import collect_allowed_segment_ids
from app.models import MeetingAnalysisRun


def resolve_study_sources(
    db: Session,
    *,
    owner_user_id: int,
    meeting_ids: list[int],
) -> list[dict[str, Any]]:
    """Resolve provenance + educationStudy for many meetings in one query path."""
    unique_ids: list[int] = []
    seen: set[int] = set()
    for mid in meeting_ids:
        value = int(mid)
        if value in seen:
            continue
        seen.add(value)
        unique_ids.append(value)

    results: list[dict[str, Any]] = []
    for meeting_id in unique_ids:
        run = _latest_education_run(db, meeting_id=meeting_id, owner_user_id=owner_user_id)
        if run is None:
            results.append(
                {
                    "meetingId": meeting_id,
                    "ready": False,
                    "notReadyReason": "EDUCATION_ANALYSIS_MISSING",
                    "analysisRunId": None,
                    "canonicalTranscriptHash": None,
                    "promptVersion": None,
                    "schemaVersion": None,
                    "analysisFeatureSet": None,
                    "educationStudy": None,
                    "allowedSegmentIds": [],
                }
            )
            continue

        payload = analysis_payload_from_run(run, cache_hit=True)
        raw_study = extract_education_study_raw(payload)
        allowed = collect_allowed_segment_ids(
            payload.get("canonicalTranscriptRows")
            or run.canonical_transcript_rows
            or []
        )
        if not allowed and isinstance(payload.get("segments"), list):
            allowed = collect_allowed_segment_ids(payload.get("segments") or [])

        education_study = None
        if isinstance(raw_study, dict):
            education_study = normalize_education_study(
                raw_study, allowed_segment_ids=allowed
            )

        ready = education_study is not None and bool(
            education_study.get("sections")
            or education_study.get("keyPoints")
            or education_study.get("mustRemember")
            or education_study.get("overview")
        )
        results.append(
            {
                "meetingId": meeting_id,
                "ready": ready,
                "notReadyReason": None if ready else "EDUCATION_STUDY_EMPTY",
                "analysisRunId": run.id,
                "canonicalTranscriptHash": run.canonical_transcript_hash,
                "promptVersion": run.prompt_version,
                "schemaVersion": run.schema_version,
                "analysisFeatureSet": (payload.get("analysisFeatureSet") or run.schema_version),
                "educationStudy": education_study,
                "allowedSegmentIds": sorted(allowed) if allowed else [],
            }
        )
    return results


def _latest_education_run(
    db: Session, *, meeting_id: int, owner_user_id: int
) -> MeetingAnalysisRun | None:
    run = latest_completed_analysis_run(db, meeting_id)
    if run is not None:
        if run.owner_id and str(run.owner_id) not in {
            str(owner_user_id),
            f"user:{owner_user_id}",
        }:
            # Prefer owner-scoped run when present; fall through to owner filter query.
            pass
        else:
            if _is_education_run(run):
                return run

    query = (
        db.query(MeetingAnalysisRun)
        .filter(
            MeetingAnalysisRun.meeting_id == meeting_id,
            MeetingAnalysisRun.status == ANALYSIS_STATUS_COMPLETED,
        )
        .order_by(MeetingAnalysisRun.completed_at.desc(), MeetingAnalysisRun.id.desc())
    )
    for candidate in query.limit(20):
        if not _is_education_run(candidate):
            continue
        if candidate.owner_id and str(candidate.owner_id) not in {
            str(owner_user_id),
            f"user:{owner_user_id}",
        }:
            continue
        return candidate
    return None


def _is_education_run(run: MeetingAnalysisRun) -> bool:
    schema = (run.schema_version or "").lower()
    prompt = (run.prompt_version or "").lower()
    if "education" in schema or "education" in prompt:
        return True
    payload = run.analysis_payload_json if isinstance(run.analysis_payload_json, dict) else {}
    return isinstance(payload.get("educationStudy"), dict) or isinstance(
        payload.get("education_study"), dict
    )
