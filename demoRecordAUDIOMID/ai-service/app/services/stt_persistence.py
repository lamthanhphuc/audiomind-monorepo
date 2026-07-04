from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256

from loguru import logger
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    TranscriptAttemptCheckpoint,
    TranscriptCheckpoint,
    TranscriptFragment,
)


def _is_omitted_optional_value(value: object) -> bool:
    """Treat missing optional provenance as absent, including FastAPI defaults.

    Blank/whitespace strings are explicit request values and must not fall back
    to legacy/unscoped behavior.
    """
    if value is None:
        return True
    module = getattr(value.__class__, "__module__", "") or ""
    name = value.__class__.__name__
    # Direct calls keep Query/Form/FieldInfo objects as Python defaults.
    if module.startswith("fastapi.") or module.startswith("pydantic."):
        return name in {
            "Body",
            "Cookie",
            "FieldInfo",
            "Form",
            "Header",
            "Param",
            "Path",
            "Query",
        }
    return False


def _coerce_optional_bigint(value: int | str | None, field_name: str) -> int | None:
    if _is_omitted_optional_value(value):
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be an integer") from exc


def _normalize_storage_stream_id(stream_id: str | None) -> str:
    normalized = (stream_id or "").strip().lower()
    if normalized == "default":
        raise ValueError('"default" is a display-only stream identity')
    return normalized


@dataclass(frozen=True)
class TranscriptProvenance:
    recording_session_id: int | None = None
    attempt_id: int | None = None

    def __post_init__(self) -> None:
        recording_session_id = _coerce_optional_bigint(
            self.recording_session_id, "recording_session_id"
        )
        attempt_id = _coerce_optional_bigint(self.attempt_id, "attempt_id")
        if (recording_session_id is None) != (attempt_id is None):
            raise ValueError(
                "recording_session_id and attempt_id must both be present or both be absent"
            )
        object.__setattr__(self, "recording_session_id", recording_session_id)
        object.__setattr__(self, "attempt_id", attempt_id)

    @property
    def is_v2(self) -> bool:
        return self.recording_session_id is not None and self.attempt_id is not None


def validate_transcript_provenance(
    recording_session_id: int | str | None = None,
    attempt_id: int | str | None = None,
) -> TranscriptProvenance:
    return TranscriptProvenance(
        recording_session_id=recording_session_id,
        attempt_id=attempt_id,
    )


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
    stream_id: str = ""
    recording_session_id: int | None = None
    attempt_id: int | None = None

    def __post_init__(self) -> None:
        provenance = validate_transcript_provenance(
            self.recording_session_id,
            self.attempt_id,
        )
        object.__setattr__(
            self, "recording_session_id", provenance.recording_session_id
        )
        object.__setattr__(self, "attempt_id", provenance.attempt_id)
        object.__setattr__(
            self, "stream_id", _normalize_storage_stream_id(self.stream_id)
        )


@dataclass(frozen=True)
class TranscriptCheckpointState:
    meeting_id: int
    last_ack_seq: int = 0
    last_persisted_seq: int = 0
    last_finalized_seq: int = 0
    stream_id: str = ""
    recording_session_id: int | None = None
    attempt_id: int | None = None


def _normalize_text(value: str | None) -> str:
    normalized = " ".join(str(value or "").split())
    return normalized.strip().lower()


def build_fragment_dedupe_key(fragment: TranscriptFragmentInput) -> str:
    provenance = validate_transcript_provenance(
        fragment.recording_session_id,
        fragment.attempt_id,
    )
    if provenance.is_v2:
        identity_parts = [
            "v2",
            str(fragment.meeting_id),
            str(provenance.recording_session_id),
            str(provenance.attempt_id),
            fragment.stream_id,
            str(fragment.seq),
        ]
    else:
        identity_parts = [
            str(fragment.meeting_id),
            fragment.stream_id,
            str(fragment.seq),
        ]
    dedupe_source = "|".join(
        identity_parts
        + [
            f"{float(fragment.start_time):.3f}",
            f"{float(fragment.end_time):.3f}",
            _normalize_text(fragment.text),
            (fragment.event_id or "").strip(),
        ]
    )
    return sha256(dedupe_source.encode("utf-8")).hexdigest()


def _build_visible_segment_key(fragment: TranscriptFragment) -> str:
    provenance = "legacy"
    if fragment.recording_session_id is not None and fragment.attempt_id is not None:
        provenance = f"v2:{fragment.recording_session_id}:{fragment.attempt_id}"
    stream_id = _normalize_storage_stream_id(fragment.stream_id)
    event_id = str(fragment.event_id or "").strip()
    if event_id:
        return f"{provenance}:{stream_id}:{event_id}"

    start_time = float(fragment.start_time or 0.0)
    if start_time > 0:
        speaker = (fragment.speaker or "system").strip() or "system"
        return (
            f"{provenance}:{stream_id}:{fragment.meeting_id}:{speaker}:{start_time:.3f}"
        )

    return (
        f"{provenance}:{stream_id}:{fragment.meeting_id}:seq:{int(fragment.seq or 0)}"
    )


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

    def _find_fragment_in_session(self, dedupe_key: str) -> TranscriptFragment | None:
        for obj in self._db.new:
            if isinstance(obj, TranscriptFragment) and obj.dedupe_key == dedupe_key:
                return obj
        return None

    def get_checkpoint(
        self, meeting_id: int, stream_id: str = ""
    ) -> TranscriptCheckpointState:
        normalized_stream_id = _normalize_storage_stream_id(stream_id)
        checkpoint = (
            self._db.query(TranscriptCheckpoint)
            .filter(
                TranscriptCheckpoint.meeting_id == meeting_id,
                TranscriptCheckpoint.stream_id == normalized_stream_id,
            )
            .first()
        )
        if checkpoint is None:
            return TranscriptCheckpointState(
                meeting_id=meeting_id,
                stream_id=normalized_stream_id,
            )
        return TranscriptCheckpointState(
            meeting_id=meeting_id,
            stream_id=normalized_stream_id,
            last_ack_seq=int(checkpoint.last_ack_seq or 0),
            last_persisted_seq=int(checkpoint.last_persisted_seq or 0),
            last_finalized_seq=int(checkpoint.last_finalized_seq or 0),
        )

    def get_attempt_checkpoint(
        self,
        meeting_id: int,
        *,
        recording_session_id: int,
        attempt_id: int,
        stream_id: str = "",
    ) -> TranscriptCheckpointState:
        provenance = validate_transcript_provenance(recording_session_id, attempt_id)
        normalized_stream_id = _normalize_storage_stream_id(stream_id)
        checkpoint = (
            self._db.query(TranscriptAttemptCheckpoint)
            .filter(
                TranscriptAttemptCheckpoint.meeting_id == meeting_id,
                TranscriptAttemptCheckpoint.recording_session_id
                == provenance.recording_session_id,
                TranscriptAttemptCheckpoint.attempt_id == provenance.attempt_id,
                TranscriptAttemptCheckpoint.stream_id == normalized_stream_id,
            )
            .first()
        )
        if checkpoint is None:
            return TranscriptCheckpointState(
                meeting_id=meeting_id,
                stream_id=normalized_stream_id,
                recording_session_id=provenance.recording_session_id,
                attempt_id=provenance.attempt_id,
            )
        return TranscriptCheckpointState(
            meeting_id=meeting_id,
            stream_id=normalized_stream_id,
            recording_session_id=provenance.recording_session_id,
            attempt_id=provenance.attempt_id,
            last_ack_seq=int(checkpoint.last_ack_seq or 0),
            last_persisted_seq=int(checkpoint.last_persisted_seq or 0),
            last_finalized_seq=int(checkpoint.last_finalized_seq or 0),
        )

    def upsert_checkpoint(
        self,
        meeting_id: int,
        *,
        stream_id: str = "",
        last_ack_seq: int | None = None,
        last_persisted_seq: int | None = None,
        last_finalized_seq: int | None = None,
    ) -> TranscriptCheckpointState:
        normalized_stream_id = _normalize_storage_stream_id(stream_id)
        checkpoint = (
            self._db.query(TranscriptCheckpoint)
            .filter(
                TranscriptCheckpoint.meeting_id == meeting_id,
                TranscriptCheckpoint.stream_id == normalized_stream_id,
            )
            .first()
        )
        if checkpoint is None:
            checkpoint = TranscriptCheckpoint(
                meeting_id=meeting_id,
                stream_id=normalized_stream_id,
            )
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
            stream_id=normalized_stream_id,
            last_ack_seq=int(checkpoint.last_ack_seq or 0),
            last_persisted_seq=int(checkpoint.last_persisted_seq or 0),
            last_finalized_seq=int(checkpoint.last_finalized_seq or 0),
        )

    def upsert_attempt_checkpoint(
        self,
        meeting_id: int,
        *,
        recording_session_id: int,
        attempt_id: int,
        stream_id: str = "",
        last_ack_seq: int | None = None,
        last_persisted_seq: int | None = None,
        last_finalized_seq: int | None = None,
    ) -> TranscriptCheckpointState:
        provenance = validate_transcript_provenance(recording_session_id, attempt_id)
        normalized_stream_id = _normalize_storage_stream_id(stream_id)
        checkpoint = (
            self._db.query(TranscriptAttemptCheckpoint)
            .filter(
                TranscriptAttemptCheckpoint.meeting_id == meeting_id,
                TranscriptAttemptCheckpoint.recording_session_id
                == provenance.recording_session_id,
                TranscriptAttemptCheckpoint.attempt_id == provenance.attempt_id,
                TranscriptAttemptCheckpoint.stream_id == normalized_stream_id,
            )
            .first()
        )
        if checkpoint is None:
            checkpoint = TranscriptAttemptCheckpoint(
                meeting_id=meeting_id,
                recording_session_id=provenance.recording_session_id,
                attempt_id=provenance.attempt_id,
                stream_id=normalized_stream_id,
            )
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
            stream_id=normalized_stream_id,
            recording_session_id=provenance.recording_session_id,
            attempt_id=provenance.attempt_id,
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
        existing = self._find_fragment_in_session(dedupe_key)
        if existing is None:
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

        version_query = self._db.query(func.max(TranscriptFragment.version)).filter(
            TranscriptFragment.meeting_id == fragment.meeting_id,
            TranscriptFragment.stream_id == fragment.stream_id,
            TranscriptFragment.seq == fragment.seq,
        )
        if fragment.recording_session_id is None:
            version_query = version_query.filter(
                TranscriptFragment.recording_session_id.is_(None),
                TranscriptFragment.attempt_id.is_(None),
            )
        else:
            version_query = version_query.filter(
                TranscriptFragment.recording_session_id
                == fragment.recording_session_id,
                TranscriptFragment.attempt_id == fragment.attempt_id,
            )
        version_query = version_query.scalar()
        next_version = int(version_query or 0) + 1
        row = TranscriptFragment(
            meeting_id=fragment.meeting_id,
            recording_session_id=fragment.recording_session_id,
            attempt_id=fragment.attempt_id,
            stream_id=fragment.stream_id,
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

    def _fragment_query(
        self,
        meeting_id: int,
        *,
        recording_session_id: int | None = None,
        attempt_id: int | None = None,
        stream_id: str | None = None,
    ):
        provenance = validate_transcript_provenance(
            recording_session_id,
            attempt_id,
        )
        query = self._db.query(TranscriptFragment).filter(
            TranscriptFragment.meeting_id == meeting_id
        )
        if provenance.is_v2:
            query = query.filter(
                TranscriptFragment.recording_session_id
                == provenance.recording_session_id,
                TranscriptFragment.attempt_id == provenance.attempt_id,
            )
            if stream_id is not None:
                query = query.filter(
                    TranscriptFragment.stream_id
                    == _normalize_storage_stream_id(stream_id)
                )
        else:
            query = query.filter(
                TranscriptFragment.recording_session_id.is_(None),
                TranscriptFragment.attempt_id.is_(None),
            )
            if stream_id is not None:
                query = query.filter(
                    TranscriptFragment.stream_id
                    == _normalize_storage_stream_id(stream_id)
                )
        return query

    def list_fragments(self, meeting_id: int) -> list[TranscriptFragment]:
        return (
            self._fragment_query(meeting_id)
            .order_by(
                TranscriptFragment.seq.asc(),
                TranscriptFragment.version.asc(),
                TranscriptFragment.created_at.asc(),
            )
            .all()
        )

    def list_attempt_fragments(
        self,
        meeting_id: int,
        *,
        recording_session_id: int,
        attempt_id: int,
        stream_id: str | None = None,
    ) -> list[TranscriptFragment]:
        return (
            self._fragment_query(
                meeting_id,
                recording_session_id=recording_session_id,
                attempt_id=attempt_id,
                stream_id=stream_id,
            )
            .order_by(
                TranscriptFragment.seq.asc(),
                TranscriptFragment.version.asc(),
                TranscriptFragment.created_at.asc(),
            )
            .all()
        )

    def assemble_transcript_text(self, meeting_id: int) -> str:
        fragments = self.assemble_visible_fragments(meeting_id)
        return self._assemble_text_from_fragments(fragments)

    def assemble_attempt_transcript_text(
        self,
        meeting_id: int,
        *,
        recording_session_id: int,
        attempt_id: int,
        stream_id: str | None = None,
    ) -> str:
        fragments = self.assemble_attempt_visible_fragments(
            meeting_id,
            recording_session_id=recording_session_id,
            attempt_id=attempt_id,
            stream_id=stream_id,
        )
        return self._assemble_text_from_fragments(fragments)

    def _assemble_text_from_fragments(self, fragments: list[TranscriptFragment]) -> str:
        if not fragments:
            return ""

        transcript_chunks: list[str] = []
        for fragment in fragments:
            text = str(fragment.text or "").strip()
            if text:
                transcript_chunks.append(text)
        return " ".join(transcript_chunks).strip()

    def assemble_visible_fragments(self, meeting_id: int) -> list[TranscriptFragment]:
        return self._assemble_visible_fragments_from(
            meeting_id, self.list_fragments(meeting_id)
        )

    def assemble_attempt_visible_fragments(
        self,
        meeting_id: int,
        *,
        recording_session_id: int,
        attempt_id: int,
        stream_id: str | None = None,
    ) -> list[TranscriptFragment]:
        fragments = self.list_attempt_fragments(
            meeting_id,
            recording_session_id=recording_session_id,
            attempt_id=attempt_id,
            stream_id=stream_id,
        )
        return self._assemble_visible_fragments_from(meeting_id, fragments)

    def _assemble_visible_fragments_from(
        self, meeting_id: int, fragments: list[TranscriptFragment]
    ) -> list[TranscriptFragment]:
        selected: dict[str, TranscriptFragment] = {}
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
                    "stream_id": _normalize_storage_stream_id(fragment.stream_id),
                    "recording_session_id": fragment.recording_session_id,
                    "attempt_id": fragment.attempt_id,
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
                    "segment_id": (fragment.event_id or None),
                    "stream_id": _normalize_storage_stream_id(fragment.stream_id),
                    "recording_session_id": fragment.recording_session_id,
                    "attempt_id": fragment.attempt_id,
                    "seq": int(fragment.seq or 0),
                    "version": int(fragment.version or 0),
                    "is_final": bool(fragment.is_final),
                }
            )
        return segments

    def assemble_attempt_visible_transcript_segments(
        self,
        meeting_id: int,
        *,
        recording_session_id: int,
        attempt_id: int,
        stream_id: str | None = None,
    ) -> list[dict[str, object]]:
        segments: list[dict[str, object]] = []
        for fragment in self.assemble_attempt_visible_fragments(
            meeting_id,
            recording_session_id=recording_session_id,
            attempt_id=attempt_id,
            stream_id=stream_id,
        ):
            segments.append(
                {
                    "speaker": fragment.speaker or "system",
                    "start_time": float(fragment.start_time or 0.0),
                    "end_time": float(fragment.end_time or 0.0),
                    "text": fragment.text or "",
                    "segment_id": (fragment.event_id or None),
                    "stream_id": _normalize_storage_stream_id(fragment.stream_id),
                    "recording_session_id": fragment.recording_session_id,
                    "attempt_id": fragment.attempt_id,
                    "seq": int(fragment.seq or 0),
                    "version": int(fragment.version or 0),
                    "is_final": bool(fragment.is_final),
                }
            )
        return segments

    def list_attempt_scopes(self, meeting_id: int) -> list[dict[str, object]]:
        scopes: list[dict[str, object]] = []

        legacy_fragment_exists = (
            self._db.query(TranscriptFragment.id)
            .filter(
                TranscriptFragment.meeting_id == meeting_id,
                TranscriptFragment.recording_session_id.is_(None),
                TranscriptFragment.attempt_id.is_(None),
            )
            .limit(1)
            .first()
            is not None
        )
        if legacy_fragment_exists:
            scopes.append(
                {
                    "scopeKind": "legacy",
                    "recordingSessionId": None,
                    "attemptId": None,
                    "finalized": True,
                }
            )

        attempt_rows = (
            self._db.query(
                TranscriptFragment.recording_session_id,
                TranscriptFragment.attempt_id,
                func.max(TranscriptFragment.created_at),
                func.max(TranscriptFragment.seq),
            )
            .filter(
                TranscriptFragment.meeting_id == meeting_id,
                TranscriptFragment.recording_session_id.isnot(None),
                TranscriptFragment.attempt_id.isnot(None),
            )
            .group_by(
                TranscriptFragment.recording_session_id,
                TranscriptFragment.attempt_id,
            )
            .all()
        )

        for (
            recording_session_id,
            attempt_id,
            latest_created_at,
            latest_seq,
        ) in attempt_rows:
            finalized = False
            checkpoint = (
                self._db.query(func.max(TranscriptAttemptCheckpoint.last_finalized_seq))
                .filter(
                    TranscriptAttemptCheckpoint.meeting_id == meeting_id,
                    TranscriptAttemptCheckpoint.recording_session_id
                    == recording_session_id,
                    TranscriptAttemptCheckpoint.attempt_id == attempt_id,
                )
                .scalar()
            )
            if checkpoint is not None and int(checkpoint) > 0:
                finalized = True
            scopes.append(
                {
                    "scopeKind": "v2",
                    "recordingSessionId": int(recording_session_id),
                    "attemptId": int(attempt_id),
                    "finalized": finalized,
                    "latestSeq": int(latest_seq or 0),
                    "updatedAt": (
                        latest_created_at.isoformat() if latest_created_at else None
                    ),
                }
            )

        scopes.sort(
            key=lambda item: (
                0 if item.get("scopeKind") == "legacy" else 1,
                int(item.get("recordingSessionId") or 0),
                int(item.get("attemptId") or 0),
            )
        )
        return scopes
