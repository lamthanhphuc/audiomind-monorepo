"""Backfill canonical transcripts for a meeting.

Usage: python -m app.scripts.backfill_canonical <meeting_id>
"""
from __future__ import annotations

import sys
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from app.database import SessionLocal
from app.services.stt_persistence import TranscriptPersistenceRepository
from app.services.transcript_canonicalizer import canonicalize_segments
from app.models import Transcript


@dataclass(frozen=True)
class BackfillResult:
    status: str
    meeting_id: int
    row_count: int
    raw_hash: Optional[str] = None
    canonical_version: Optional[str] = None
    canonical_hash: Optional[str] = None


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

    # When rank cannot be compared safely, do not overwrite.
    if existing_rank is None or incoming_rank is None:
        return True

    return existing_rank > incoming_rank


def backfill(
    meeting_id: int,
    *,
    generated_at: datetime | None = None,
) -> BackfillResult:
    db = SessionLocal()
    try:
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

        # Sidecar lives on one transcript row (lowest id) and must not alter raw fields.
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
        existing_canonical_rows = getattr(
            transcript_row, "canonical_transcript_rows", None
        )
        existing_rows_match = (
            isinstance(existing_canonical_rows, list)
            and existing_canonical_rows == result.rows
        )
        existing_rows_available = (
            isinstance(existing_canonical_rows, list)
            and len(existing_canonical_rows) > 0
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

        transcript_row.raw_transcript_hash = result.raw_hash
        transcript_row.canonical_transcript_rows = result.rows
        transcript_row.canonical_transcript_version = result.version
        transcript_row.canonical_transcript_hash = result.canonical_hash
        transcript_row.canonical_generated_at = generated_at or datetime.utcnow()
        transcript_row.canonical_stats = result.stats

        db.commit()
        print(
            f"Backfilled canonical transcript for meeting {meeting_id}: rows={len(result.rows)}"
        )
        return BackfillResult(
            status="updated",
            meeting_id=meeting_id,
            row_count=len(result.rows),
            raw_hash=result.raw_hash,
            canonical_version=result.version,
            canonical_hash=result.canonical_hash,
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
