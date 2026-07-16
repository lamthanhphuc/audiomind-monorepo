"""Backfill canonical transcripts for a meeting.

Targets meeting_analysis_runs (Epic 3) when an analysis run exists;
falls back to legacy transcripts sidecar otherwise.

Usage: python -m app.scripts.backfill_canonical <meeting_id>
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from loguru import logger
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import MeetingAnalysisRun, Transcript
from app.services.canonical_persist_service import (
    assign_segment_ids,
    resolve_latest_run_id,
)
from app.services.evidence_stats import (
    compute_evidence_stats,
    enrich_rows_with_term_frequency,
)
from app.services.stt_persistence import TranscriptPersistenceRepository
from app.services.transcript_canonicalizer import (
    build_canonical_transcript_hash,
    canonicalize_segments,
)


@dataclass(frozen=True)
class BackfillResult:
    status: str
    meeting_id: int
    row_count: int
    run_id: int | None = None
    raw_hash: str | None = None
    canonical_version: str | None = None
    canonical_hash: str | None = None


def _normalize_version(value: str | None) -> str:
    return str(value or "").strip().lower()


def _version_rank(value: str | None) -> int | None:
    normalized = _normalize_version(value)
    if not normalized:
        return None
    match = re.search(r"(?:^|[\-_])v(\d+)$", normalized)
    if match is None:
        return None
    return int(match.group(1))


def _should_skip_because_existing_is_newer(
    *,
    existing_version: str | None,
    incoming_version: str,
) -> bool:
    normalized_existing = _normalize_version(existing_version)
    normalized_incoming = _normalize_version(incoming_version)
    if not normalized_existing or normalized_existing == normalized_incoming:
        return False

    existing_rank = _version_rank(normalized_existing)
    incoming_rank = _version_rank(normalized_incoming)

    if existing_rank is None or incoming_rank is None:
        return True

    return existing_rank > incoming_rank


def _log_backfill_progress(
    *,
    meeting_id: int,
    run_id: int | None,
    row_count: int,
    worker_id: int | None,
    dry_run: bool,
) -> None:
    logger.info(
        "event=BACKFILL_PROGRESS meetingId={} runId={} rowCount={} workerId={} dryRun={}",
        meeting_id,
        run_id,
        row_count,
        worker_id,
        dry_run,
    )


def _preview_analysis_run_backfill(
    meeting_id: int,
    run_id: int,
    *,
    rebuild_stats: bool,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None, str, str]:
    db = SessionLocal()
    try:
        repo = TranscriptPersistenceRepository(db)
        segments = repo.assemble_visible_transcript_segments(meeting_id)
        if not segments:
            return [], None, "", ""

        result = canonicalize_segments(segments)
        rows = assign_segment_ids(result.rows, meeting_id)
        stats: dict[str, Any] | None = None
        if rebuild_stats:
            rows = enrich_rows_with_term_frequency(rows)
            stats = compute_evidence_stats(rows, version=result.version)
        canonical_hash = build_canonical_transcript_hash(rows, version=result.version)
        return rows, stats, result.version, canonical_hash
    finally:
        db.close()


def _backfill_meeting_analysis_run(
    db: Session,
    meeting_id: int,
    run_id: int,
    *,
    rebuild_stats: bool,
    dry_run: bool,
    worker_id: int | None,
) -> BackfillResult:
    repo = TranscriptPersistenceRepository(db)
    segments = repo.assemble_visible_transcript_segments(meeting_id)
    if not segments:
        return BackfillResult(
            status="no_segments",
            meeting_id=meeting_id,
            run_id=run_id,
            row_count=0,
        )

    result = canonicalize_segments(segments)
    rows = assign_segment_ids(result.rows, meeting_id)
    stats: dict[str, Any] | None = None
    if rebuild_stats:
        rows = enrich_rows_with_term_frequency(rows)
        stats = compute_evidence_stats(rows, version=result.version)
    canonical_hash = build_canonical_transcript_hash(rows, version=result.version)

    if dry_run:
        idf = (stats or {}).get("idf") or {}
        sample_tf = rows[0].get("term_frequency") if rows else {}
        print(
            f"DRY RUN meeting_id={meeting_id} run_id={run_id} rows={len(rows)} "
            f"idf_keys={list(idf.keys())[:8]} sample_term_frequency={sample_tf}"
        )
        _log_backfill_progress(
            meeting_id=meeting_id,
            run_id=run_id,
            row_count=len(rows),
            worker_id=worker_id,
            dry_run=True,
        )
        return BackfillResult(
            status="dry_run",
            meeting_id=meeting_id,
            run_id=run_id,
            row_count=len(rows),
            raw_hash=result.raw_hash,
            canonical_version=result.version,
            canonical_hash=canonical_hash,
        )

    run = db.query(MeetingAnalysisRun).filter(MeetingAnalysisRun.id == run_id).first()
    if run is None:
        return BackfillResult(
            status="no_analysis_run",
            meeting_id=meeting_id,
            run_id=run_id,
            row_count=0,
        )

    run.canonical_transcript_rows = rows
    run.canonical_transcript_version = result.version
    run.canonical_transcript_hash = canonical_hash
    if rebuild_stats and stats is not None:
        run.evidence_stats = stats

    db.commit()
    _log_backfill_progress(
        meeting_id=meeting_id,
        run_id=run_id,
        row_count=len(rows),
        worker_id=worker_id,
        dry_run=False,
    )
    print(
        f"Backfilled meeting_analysis_runs for meeting {meeting_id}: "
        f"runId={run_id} rows={len(rows)} rebuild_stats={rebuild_stats}"
    )
    return BackfillResult(
        status="updated",
        meeting_id=meeting_id,
        run_id=run_id,
        row_count=len(rows),
        raw_hash=result.raw_hash,
        canonical_version=result.version,
        canonical_hash=canonical_hash,
    )


def _backfill_legacy_transcript_sidecar(
    db: Session,
    meeting_id: int,
    *,
    generated_at: datetime | None,
    dry_run: bool,
    worker_id: int | None,
) -> BackfillResult:
    repo = TranscriptPersistenceRepository(db)
    segments = repo.assemble_visible_transcript_segments(meeting_id)

    if not segments:
        print(f"No transcript segments available for meeting {meeting_id}")
        return BackfillResult(
            status="no_segments",
            meeting_id=meeting_id,
            row_count=0,
        )

    result = canonicalize_segments(segments)

    transcript_row = (
        db.query(Transcript)
        .filter(Transcript.meeting_id == meeting_id)
        .order_by(Transcript.id.asc())
        .first()
    )
    if transcript_row is None:
        transcript_row = Transcript(meeting_id=meeting_id, text="")
        db.add(transcript_row)

    existing_version = str(
        getattr(transcript_row, "canonical_transcript_version", None) or ""
    ).strip()
    existing_raw_hash = str(
        getattr(transcript_row, "raw_transcript_hash", None) or ""
    ).strip()
    existing_canonical_hash = str(
        getattr(transcript_row, "canonical_transcript_hash", None) or ""
    ).strip()
    existing_canonical_rows = getattr(transcript_row, "canonical_transcript_rows", None)
    existing_rows_match = (
        isinstance(existing_canonical_rows, list)
        and existing_canonical_rows == result.rows
    )
    existing_rows_available = (
        isinstance(existing_canonical_rows, list) and len(existing_canonical_rows) > 0
    )

    if (
        existing_rows_available
        and existing_raw_hash
        and existing_canonical_hash
        and _should_skip_because_existing_is_newer(
            existing_version=existing_version,
            incoming_version=result.version,
        )
    ):
        return BackfillResult(
            status="skipped_existing_newer",
            meeting_id=meeting_id,
            row_count=len(result.rows),
            raw_hash=result.raw_hash,
            canonical_version=result.version,
            canonical_hash=result.canonical_hash,
        )

    if (
        existing_version == result.version
        and existing_raw_hash == result.raw_hash
        and existing_canonical_hash == result.canonical_hash
        and existing_rows_match
    ):
        return BackfillResult(
            status="noop_idempotent",
            meeting_id=meeting_id,
            row_count=len(result.rows),
            raw_hash=result.raw_hash,
            canonical_version=result.version,
            canonical_hash=result.canonical_hash,
        )

    if dry_run:
        print(
            f"DRY RUN legacy sidecar meeting_id={meeting_id} rows={len(result.rows)} "
            f"version={result.version}"
        )
        _log_backfill_progress(
            meeting_id=meeting_id,
            run_id=None,
            row_count=len(result.rows),
            worker_id=worker_id,
            dry_run=True,
        )
        return BackfillResult(
            status="dry_run",
            meeting_id=meeting_id,
            row_count=len(result.rows),
            raw_hash=result.raw_hash,
            canonical_version=result.version,
            canonical_hash=result.canonical_hash,
        )

    transcript_row.raw_transcript_hash = result.raw_hash
    transcript_row.canonical_transcript_rows = result.rows
    transcript_row.canonical_transcript_version = result.version
    transcript_row.canonical_transcript_hash = result.canonical_hash
    transcript_row.canonical_generated_at = generated_at or datetime.utcnow()
    transcript_row.canonical_stats = result.stats

    db.commit()
    _log_backfill_progress(
        meeting_id=meeting_id,
        run_id=None,
        row_count=len(result.rows),
        worker_id=worker_id,
        dry_run=False,
    )
    print(
        f"Backfilled canonical transcript sidecar for meeting {meeting_id}: rows={len(result.rows)}"
    )
    return BackfillResult(
        status="updated",
        meeting_id=meeting_id,
        row_count=len(result.rows),
        raw_hash=result.raw_hash,
        canonical_version=result.version,
        canonical_hash=result.canonical_hash,
    )


def backfill(
    meeting_id: int,
    *,
    generated_at: datetime | None = None,
    rebuild_stats: bool = True,
    dry_run: bool = False,
    worker_id: int | None = None,
) -> BackfillResult:
    db = SessionLocal()
    try:
        run_id = resolve_latest_run_id(db, meeting_id)
        if run_id is not None:
            return _backfill_meeting_analysis_run(
                db,
                meeting_id,
                run_id,
                rebuild_stats=rebuild_stats,
                dry_run=dry_run,
                worker_id=worker_id,
            )
        return _backfill_legacy_transcript_sidecar(
            db,
            meeting_id,
            generated_at=generated_at,
            dry_run=dry_run,
            worker_id=worker_id,
        )
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python -m app.scripts.backfill_canonical <meeting_id>")
        sys.exit(2)
    mid = int(sys.argv[1])
    backfill(mid)
