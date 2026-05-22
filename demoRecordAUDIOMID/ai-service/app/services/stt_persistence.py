from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256

from loguru import logger
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import TranscriptCheckpoint, TranscriptFragment


@dataclass(frozen=True)
class TranscriptFragmentInput:
    meeting_id: int
    seq: int
    text: str
    speaker: str = "system"
    start_time: float = 0.0
    end_time: float = 0.0
    event_id: str | None = None
    is_final: bool = False
    confidence: float | None = None


@dataclass(frozen=True)
class TranscriptCheckpointState:
    meeting_id: int
    last_ack_seq: int = 0
    last_persisted_seq: int = 0
    last_finalized_seq: int = 0


def _normalize_text(value: str | None) -> str:
    normalized = " ".join(str(value or "").split())
    return normalized.strip().lower()


def build_fragment_dedupe_key(fragment: TranscriptFragmentInput) -> str:
    dedupe_source = "|".join(
        [
            str(fragment.meeting_id),
            str(fragment.seq),
            f"{float(fragment.start_time):.3f}",
            f"{float(fragment.end_time):.3f}",
            _normalize_text(fragment.text),
            (fragment.event_id or "").strip(),
        ]
    )
    return sha256(dedupe_source.encode("utf-8")).hexdigest()


def _build_visible_segment_key(fragment: TranscriptFragment) -> str:
    event_id = str(fragment.event_id or "").strip()
    if event_id:
        return event_id

    start_time = float(fragment.start_time or 0.0)
    if start_time > 0:
        speaker = (fragment.speaker or "system").strip() or "system"
        return f"{fragment.meeting_id}:{speaker}:{start_time:.3f}"

    return f"{fragment.meeting_id}:seq:{int(fragment.seq or 0)}"


def _fragment_preference_score(
    *,
    text: str,
    is_final: bool,
    confidence: float | None,
) -> tuple[int, int, float]:
    return (
        1 if is_final else 0,
        len(text.strip()),
        float(confidence) if confidence is not None else -1.0,
    )


def _should_replace_existing_fragment(
    existing: TranscriptFragment,
    fragment: TranscriptFragmentInput,
) -> bool:
    existing_score = _fragment_preference_score(
        text=str(existing.text or ""),
        is_final=bool(existing.is_final),
        confidence=(
            float(existing.confidence) if existing.confidence is not None else None
        ),
    )
    incoming_score = _fragment_preference_score(
        text=str(fragment.text or ""),
        is_final=bool(fragment.is_final),
        confidence=fragment.confidence,
    )
    return incoming_score > existing_score


def _update_existing_fragment(
    existing: TranscriptFragment,
    fragment: TranscriptFragmentInput,
) -> TranscriptFragment:
    existing.seq = int(fragment.seq)
    existing.event_id = fragment.event_id or None
    existing.speaker = (fragment.speaker or "system").strip() or "system"
    existing.start_time = float(fragment.start_time)
    existing.end_time = float(fragment.end_time)
    existing.text = str(fragment.text or "")
    existing.normalized_text = _normalize_text(fragment.text)
    existing.is_final = bool(fragment.is_final)
    existing.confidence = fragment.confidence
    return existing


class TranscriptPersistenceRepository:
    def __init__(self, db: Session):
        self._db = db

    def get_checkpoint(self, meeting_id: int) -> TranscriptCheckpointState:
        checkpoint = (
            self._db.query(TranscriptCheckpoint)
            .filter(TranscriptCheckpoint.meeting_id == meeting_id)
            .first()
        )
        if checkpoint is None:
            return TranscriptCheckpointState(meeting_id=meeting_id)
        return TranscriptCheckpointState(
            meeting_id=meeting_id,
            last_ack_seq=int(checkpoint.last_ack_seq or 0),
            last_persisted_seq=int(checkpoint.last_persisted_seq or 0),
            last_finalized_seq=int(checkpoint.last_finalized_seq or 0),
        )

    def upsert_checkpoint(
        self,
        meeting_id: int,
        *,
        last_ack_seq: int | None = None,
        last_persisted_seq: int | None = None,
        last_finalized_seq: int | None = None,
    ) -> TranscriptCheckpointState:
        checkpoint = (
            self._db.query(TranscriptCheckpoint)
            .filter(TranscriptCheckpoint.meeting_id == meeting_id)
            .first()
        )
        if checkpoint is None:
            checkpoint = TranscriptCheckpoint(meeting_id=meeting_id)
            self._db.add(checkpoint)

        if last_ack_seq is not None:
            checkpoint.last_ack_seq = max(
                int(last_ack_seq), int(checkpoint.last_ack_seq or 0)
            )
        if last_persisted_seq is not None:
            checkpoint.last_persisted_seq = max(
                int(last_persisted_seq), int(checkpoint.last_persisted_seq or 0)
            )
        if last_finalized_seq is not None:
            checkpoint.last_finalized_seq = max(
                int(last_finalized_seq), int(checkpoint.last_finalized_seq or 0)
            )

        return TranscriptCheckpointState(
            meeting_id=meeting_id,
            last_ack_seq=int(checkpoint.last_ack_seq or 0),
            last_persisted_seq=int(checkpoint.last_persisted_seq or 0),
            last_finalized_seq=int(checkpoint.last_finalized_seq or 0),
        )

    def append_fragment(
        self,
        fragment: TranscriptFragmentInput,
    ) -> TranscriptFragment:
        dedupe_key = build_fragment_dedupe_key(fragment)
        logger.info(
            "STT_FRAGMENT_VISIBLE_INPUT meeting_id={} seq={} segment_id={} start={} end={} is_final={} text_len={}",
            fragment.meeting_id,
            fragment.seq,
            (fragment.event_id or "").strip()
            or f"{fragment.meeting_id}:seq:{fragment.seq}",
            f"{float(fragment.start_time):.3f}",
            f"{float(fragment.end_time):.3f}",
            bool(fragment.is_final),
            len(str(fragment.text or "")),
        )
        existing = (
            self._db.query(TranscriptFragment)
            .filter(TranscriptFragment.dedupe_key == dedupe_key)
            .first()
        )
        if existing is not None:
            logger.info(
                "STT_FRAGMENT_DEDUPE_HIT meeting_id={} seq={} dedupe_key={}",
                fragment.meeting_id,
                fragment.seq,
                dedupe_key,
            )
            if _should_replace_existing_fragment(existing, fragment):
                _update_existing_fragment(existing, fragment)
            return existing

        version_query = (
            self._db.query(func.max(TranscriptFragment.version))
            .filter(
                TranscriptFragment.meeting_id == fragment.meeting_id,
                TranscriptFragment.seq == fragment.seq,
            )
            .scalar()
        )
        next_version = int(version_query or 0) + 1
        row = TranscriptFragment(
            meeting_id=fragment.meeting_id,
            seq=fragment.seq,
            version=next_version,
            event_id=(fragment.event_id or None),
            speaker=(fragment.speaker or "system").strip() or "system",
            start_time=float(fragment.start_time),
            end_time=float(fragment.end_time),
            text=str(fragment.text or ""),
            normalized_text=_normalize_text(fragment.text),
            is_final=bool(fragment.is_final),
            confidence=fragment.confidence,
            dedupe_key=dedupe_key,
        )
        self._db.add(row)
        logger.info(
            "STT_PERSIST_FRAGMENT meeting_id={} seq={} start={} end={} is_final={} text_len={}",
            fragment.meeting_id,
            fragment.seq,
            f"{float(fragment.start_time):.3f}",
            f"{float(fragment.end_time):.3f}",
            bool(fragment.is_final),
            len(str(fragment.text or "")),
        )
        logger.info(
            "STT_PERSIST_CHECKPOINT meeting_id={} seq={} version={} dedupe_key={}",
            fragment.meeting_id,
            fragment.seq,
            next_version,
            dedupe_key,
        )
        return row

    def list_fragments(self, meeting_id: int) -> list[TranscriptFragment]:
        return (
            self._db.query(TranscriptFragment)
            .filter(TranscriptFragment.meeting_id == meeting_id)
            .order_by(
                TranscriptFragment.seq.asc(),
                TranscriptFragment.version.asc(),
                TranscriptFragment.created_at.asc(),
            )
            .all()
        )

    def assemble_transcript_text(self, meeting_id: int) -> str:
        fragments = self.assemble_visible_fragments(meeting_id)
        if not fragments:
            return ""

        transcript_chunks: list[str] = []
        for fragment in fragments:
            text = str(fragment.text or "").strip()
            if text:
                transcript_chunks.append(text)
        return " ".join(transcript_chunks).strip()

    def assemble_visible_fragments(self, meeting_id: int) -> list[TranscriptFragment]:
        selected: dict[str, TranscriptFragment] = {}
        fragments = self.list_fragments(meeting_id)
        min_start: float | None = None
        max_end: float | None = None
        for fragment in fragments:
            text = str(fragment.text or "").strip()
            if not text:
                continue

            key = _build_visible_segment_key(fragment)
            logger.info(
                "STT_FRAGMENT_VISIBLE_INPUT meeting_id={} seq={} segment_id={} start={} end={} is_final={} text_len={}",
                meeting_id,
                int(fragment.seq or 0),
                key,
                f"{float(fragment.start_time or 0.0):.3f}",
                f"{float(fragment.end_time or 0.0):.3f}",
                bool(fragment.is_final),
                len(text),
            )
            existing = selected.get(key)
            if existing is None:
                selected[key] = fragment
                start_value = float(fragment.start_time or 0.0)
                end_value = float(fragment.end_time or start_value)
                min_start = (
                    start_value if min_start is None else min(min_start, start_value)
                )
                max_end = end_value if max_end is None else max(max_end, end_value)
                continue

            if existing.is_final and not fragment.is_final:
                continue

            selected[key] = fragment
            start_value = float(fragment.start_time or 0.0)
            end_value = float(fragment.end_time or start_value)
            min_start = (
                start_value if min_start is None else min(min_start, start_value)
            )
            max_end = end_value if max_end is None else max(max_end, end_value)

        logger.info(
            "STT_FRAGMENT_VISIBLE_OUTPUT meeting_id={} rows={} min_start={} max_end={}",
            meeting_id,
            len(selected),
            None if min_start is None else f"{min_start:.3f}",
            None if max_end is None else f"{max_end:.3f}",
        )

        return list(selected.values())

    def assemble_transcript_segments(self, meeting_id: int) -> list[dict[str, object]]:
        segments: list[dict[str, object]] = []
        for fragment in self.list_fragments(meeting_id):
            segments.append(
                {
                    "speaker": fragment.speaker or "system",
                    "start_time": float(fragment.start_time or 0.0),
                    "end_time": float(fragment.end_time or 0.0),
                    "text": fragment.text or "",
                    "segment_id": (fragment.event_id or None),
                    "seq": int(fragment.seq or 0),
                    "version": int(fragment.version or 0),
                    "is_final": bool(fragment.is_final),
                }
            )
        return segments

    def assemble_visible_transcript_segments(
        self, meeting_id: int
    ) -> list[dict[str, object]]:
        segments: list[dict[str, object]] = []
        for fragment in self.assemble_visible_fragments(meeting_id):
            segments.append(
                {
                    "speaker": fragment.speaker or "system",
                    "start_time": float(fragment.start_time or 0.0),
                    "end_time": float(fragment.end_time or 0.0),
                    "text": fragment.text or "",
                    "seq": int(fragment.seq or 0),
                    "version": int(fragment.version or 0),
                    "is_final": bool(fragment.is_final),
                }
            )
        return segments
