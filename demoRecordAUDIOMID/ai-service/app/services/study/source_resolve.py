"""Bulk resolve study sources for subject synthesis / artifacts.

Accepts any completed analysis domain (education, IT, business, general).
When ``educationStudy`` is missing, projects a study-shaped payload from the
general analysis fields so ALL_READY generation works across domains.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.services.analysis_runs import (
    ANALYSIS_STATUS_COMPLETED,
    analysis_payload_from_run,
    latest_completed_analysis_run,
)
from app.services.education_analysis import (
    build_fallback_education_study,
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
    """Resolve provenance + study payload for many meetings in one query path."""
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
        run = _latest_study_run(db, meeting_id=meeting_id, owner_user_id=owner_user_id)
        if run is None:
            results.append(
                {
                    "meetingId": meeting_id,
                    "ready": False,
                    "notReadyReason": "ANALYSIS_MISSING",
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
        if not isinstance(payload, dict):
            payload = {}
        allowed = collect_allowed_segment_ids(
            payload.get("canonicalTranscriptRows")
            or run.canonical_transcript_rows
            or []
        )
        if not allowed and isinstance(payload.get("segments"), list):
            allowed = collect_allowed_segment_ids(payload.get("segments") or [])

        education_study = _resolve_study_payload(payload, allowed_segment_ids=allowed)
        ready = _study_has_content(education_study)
        results.append(
            {
                "meetingId": meeting_id,
                "ready": ready,
                "notReadyReason": None if ready else "STUDY_CONTENT_EMPTY",
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


def _study_has_content(study: dict[str, Any] | None) -> bool:
    if not isinstance(study, dict):
        return False
    return bool(
        study.get("sections")
        or study.get("keyPoints")
        or study.get("mustRemember")
        or str(study.get("overview") or "").strip()
    )


def _resolve_study_payload(
    payload: dict[str, Any],
    *,
    allowed_segment_ids: set[str] | list[str] | None,
) -> dict[str, Any] | None:
    """Prefer native educationStudy; otherwise project from any-domain analysis."""
    raw_study = extract_education_study_raw(payload)
    if isinstance(raw_study, dict):
        education_study = normalize_education_study(
            raw_study, allowed_segment_ids=allowed_segment_ids
        )
        if _study_has_content(education_study):
            return education_study

    projected = _project_study_from_general_analysis(payload)
    if projected is None:
        return None
    return normalize_education_study(
        projected, allowed_segment_ids=allowed_segment_ids
    )


def _project_study_from_general_analysis(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Build a study-shaped object from IT/business/general analysis fields."""
    nested = payload.get("analysis") if isinstance(payload.get("analysis"), dict) else {}
    summary = str(
        payload.get("summary")
        or payload.get("meetingSummary")
        or nested.get("summary")
        or ""
    ).strip()

    keywords = _coerce_string_list(payload.get("keywords") or nested.get("keywords"))
    technical_terms = (
        payload.get("technicalTerms")
        or payload.get("glossary")
        or nested.get("technicalTerms")
        or nested.get("glossary")
        or []
    )

    study = build_fallback_education_study(
        summary=summary or None,
        keywords=keywords,
        technical_terms=technical_terms if isinstance(technical_terms, (list, tuple)) else [],
    )

    extra_points: list[dict[str, Any]] = list(study.get("keyPoints") or [])
    for item in _coerce_content_items(payload.get("actionItems") or nested.get("actionItems")):
        extra_points.append(
            {"content": item, "importance": "HIGH", "sourceSegmentIds": []}
        )
    for item in _coerce_content_items(payload.get("painPoints") or nested.get("painPoints")):
        extra_points.append(
            {"content": item, "importance": "MEDIUM", "sourceSegmentIds": []}
        )
    # Cap to keep token budgets predictable.
    study["keyPoints"] = extra_points[:12]

    if not summary and not keywords and not study["keyPoints"] and not study.get("glossary"):
        return None

    if not str(study.get("overview") or "").strip() and study["keyPoints"]:
        study["overview"] = str(study["keyPoints"][0].get("content") or "")[:500]

    return study


def _coerce_string_list(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    out: list[str] = []
    for item in value:
        text = str(item).strip() if not isinstance(item, dict) else str(
            item.get("term") or item.get("content") or item.get("text") or ""
        ).strip()
        if text:
            out.append(text)
    return out[:12]


def _coerce_content_items(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, dict):
            text = str(
                item.get("content")
                or item.get("title")
                or item.get("summary")
                or item.get("description")
                or item.get("text")
                or ""
            ).strip()
        else:
            text = str(item).strip()
        if text:
            out.append(text)
    return out[:8]


def _latest_study_run(
    db: Session, *, meeting_id: int, owner_user_id: int
) -> MeetingAnalysisRun | None:
    """Prefer an education run when present; otherwise any completed owner analysis."""
    run = latest_completed_analysis_run(db, meeting_id)
    if run is not None and _owner_matches(run, owner_user_id):
        if _is_education_run(run) or _run_has_usable_payload(run):
            return run

    query = (
        db.query(MeetingAnalysisRun)
        .filter(
            MeetingAnalysisRun.meeting_id == meeting_id,
            MeetingAnalysisRun.status == ANALYSIS_STATUS_COMPLETED,
        )
        .order_by(MeetingAnalysisRun.completed_at.desc(), MeetingAnalysisRun.id.desc())
    )
    any_fallback: MeetingAnalysisRun | None = None
    for candidate in query.limit(20):
        if not _owner_matches(candidate, owner_user_id):
            continue
        if _is_education_run(candidate):
            return candidate
        if any_fallback is None and _run_has_usable_payload(candidate):
            any_fallback = candidate
    return any_fallback


def _owner_matches(run: MeetingAnalysisRun, owner_user_id: int) -> bool:
    if not run.owner_id:
        return True
    return str(run.owner_id) in {
        str(owner_user_id),
        f"user:{owner_user_id}",
    }


def _run_has_usable_payload(run: MeetingAnalysisRun) -> bool:
    payload = run.analysis_payload_json if isinstance(run.analysis_payload_json, dict) else {}
    if not payload and hasattr(run, "analysis_payload_json"):
        # Some tests use SimpleNamespace without full analysis accessors.
        pass
    if extract_education_study_raw(payload) is not None:
        return True
    nested = payload.get("analysis") if isinstance(payload.get("analysis"), dict) else {}
    return bool(
        str(payload.get("summary") or nested.get("summary") or "").strip()
        or payload.get("keywords")
        or nested.get("keywords")
        or payload.get("actionItems")
        or nested.get("actionItems")
        or payload.get("painPoints")
        or nested.get("painPoints")
        or payload.get("technicalTerms")
        or payload.get("glossary")
    )


def _is_education_run(run: MeetingAnalysisRun) -> bool:
    schema = (run.schema_version or "").lower()
    prompt = (run.prompt_version or "").lower()
    if "education" in schema or "education" in prompt:
        return True
    payload = run.analysis_payload_json if isinstance(run.analysis_payload_json, dict) else {}
    return isinstance(payload.get("educationStudy"), dict) or isinstance(
        payload.get("education_study"), dict
    )
