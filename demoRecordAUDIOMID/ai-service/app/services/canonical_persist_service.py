"""Canonical persist service for meeting_analysis_runs (Epic 3 Slice 2)."""

from __future__ import annotations

import time
from typing import Any
from uuid import uuid4

from loguru import logger
from sqlalchemy.orm import Session

from app.models import MeetingAnalysisRun
from app.services.evidence_stats import (
    compute_evidence_stats,
    enrich_rows_with_term_frequency,
)
from app.services.stt_persistence import TranscriptPersistenceRepository
from app.services.transcript_canonicalizer import (
    build_canonical_transcript_hash,
    canonicalize_segments,
)


def resolve_latest_run_id(db: Session, meeting_id: int) -> int | None:
    run = (
        db.query(MeetingAnalysisRun)
        .filter(MeetingAnalysisRun.meeting_id == meeting_id)
        .order_by(MeetingAnalysisRun.updated_at.desc())
        .first()
    )
    return int(run.id) if run is not None else None


def assign_segment_ids(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    for row in rows:
        copy = dict(row)
        if not copy.get("segment_id"):
            copy["segment_id"] = str(uuid4())
        enriched.append(copy)
    return enriched


def rows_to_camel_case_dto(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    dto_rows: list[dict[str, Any]] = []
    for row in rows:
        dto_rows.append(
            {
                "segmentId": row.get("segment_id"),
                "text": row.get("text"),
                "speaker": row.get("speaker"),
                "startTime": row.get("start_time"),
                "endTime": row.get("end_time"),
                "termFrequency": row.get("term_frequency") or {},
            }
        )
    return dto_rows


def evidence_stats_to_camel_case(stats: dict[str, Any]) -> dict[str, Any]:
    return {
        "idf": stats.get("idf") or {},
        "segmentCount": stats.get("segment_count"),
        "computedAt": stats.get("computed_at"),
        "canonicalVersion": stats.get("canonical_version"),
    }


def build_transcript_quality_dto(
    run: MeetingAnalysisRun, meeting_id: int
) -> dict[str, Any]:
    rows = run.canonical_transcript_rows
    stats = run.evidence_stats
    ready = (
        isinstance(rows, list)
        and len(rows) > 0
        and isinstance(stats, dict)
        and run.canonical_transcript_hash is not None
    )
    if not ready:
        return {"meetingId": meeting_id, "ready": False}

    return {
        "meetingId": meeting_id,
        "canonicalTranscriptVersion": run.canonical_transcript_version,
        "canonicalTranscriptHash": run.canonical_transcript_hash,
        "canonicalTranscriptRows": rows_to_camel_case_dto(rows),
        "evidenceStats": evidence_stats_to_camel_case(stats),
        "ready": True,
    }


def canonicalize_and_persist_run(
    db: Session,
    meeting_id: int,
    run_id: int,
) -> dict[str, Any]:
    """Canonicalize segments and persist to meeting_analysis_runs."""
    started = time.perf_counter()
    run = db.query(MeetingAnalysisRun).filter(MeetingAnalysisRun.id == run_id).first()
    if run is None:
        raise ValueError(f"analysis run not found: {run_id}")

    repo = TranscriptPersistenceRepository(db)
    segments = repo.assemble_visible_transcript_segments(meeting_id)
    rows_before = len(segments)

    result = canonicalize_segments(segments)
    rows = assign_segment_ids(result.rows)
    rows = enrich_rows_with_term_frequency(rows)
    stats = compute_evidence_stats(rows, version=result.version)
    canonical_hash = build_canonical_transcript_hash(rows, version=result.version)

    run.canonical_transcript_rows = rows
    run.evidence_stats = stats
    run.canonical_transcript_version = result.version
    run.canonical_transcript_hash = canonical_hash
    db.commit()

    duration_ms = int((time.perf_counter() - started) * 1000)
    logger.info(
        "event=TRANSCRIPT_QUALITY_CANONICAL_PERSISTED meetingId={} rowsBefore={} rowsAfter={} durationMs={} version={}",
        meeting_id,
        rows_before,
        len(rows),
        duration_ms,
        result.version,
    )
    return {
        "meeting_id": meeting_id,
        "run_id": run_id,
        "rows_before": rows_before,
        "rows_after": len(rows),
        "duration_ms": duration_ms,
        "canonical_hash": canonical_hash,
        "version": result.version,
    }


def preview_canonical_hash(db: Session, meeting_id: int) -> tuple[str, str]:
    repo = TranscriptPersistenceRepository(db)
    segments = repo.assemble_visible_transcript_segments(meeting_id)
    result = canonicalize_segments(segments)
    return result.version, build_canonical_transcript_hash(
        result.rows, version=result.version
    )
