from sqlalchemy import (
    Column,
    Integer,
    BigInteger,
    String,
    Text,
    DateTime,
    Float,
    Boolean,
    ForeignKey,
    JSON,
    Index,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship
from datetime import datetime
from app.database import Base


class Transcript(Base):
    __tablename__ = "transcripts"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(BigInteger, nullable=False, index=True)
    speaker = Column(String(50))
    start_time = Column(Float)
    end_time = Column(Float)
    text = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Canonical sidecar metadata (7Q MVP)
    raw_transcript_hash = Column(String(64), nullable=True)
    canonical_transcript_rows = Column(JSON, nullable=True)
    canonical_transcript_version = Column(String(64), nullable=True)
    canonical_transcript_hash = Column(String(64), nullable=True)
    canonical_generated_at = Column(DateTime, nullable=True)
    canonical_stats = Column(JSON, nullable=True)

    # Relationship
    analysis = relationship("Analysis", back_populates="transcript", uselist=False)


class TranscriptFragment(Base):
    __tablename__ = "transcript_fragments"
    __table_args__ = (
        UniqueConstraint("dedupe_key", name="uq_transcript_fragments_dedupe_key"),
    )

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(BigInteger, nullable=False, index=True)
    seq = Column(Integer, nullable=False, index=True)
    version = Column(Integer, nullable=False, default=1)
    event_id = Column(String(64), nullable=True, index=True)
    speaker = Column(String(50), nullable=True)
    start_time = Column(Float)
    end_time = Column(Float)
    text = Column(Text)
    normalized_text = Column(String(2048), nullable=False)
    is_final = Column(Boolean, default=False, nullable=False)
    confidence = Column(Float, nullable=True)
    dedupe_key = Column(String(128), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class TranscriptCheckpoint(Base):
    __tablename__ = "transcript_checkpoints"

    meeting_id = Column(BigInteger, primary_key=True, index=True)
    last_ack_seq = Column(Integer, nullable=False, default=0)
    last_persisted_seq = Column(Integer, nullable=False, default=0)
    last_finalized_seq = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class Analysis(Base):
    __tablename__ = "analysis"

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(BigInteger, nullable=False, unique=True, index=True)
    summary = Column(Text)
    keywords = Column(JSON)  # List of keywords
    technical_terms = Column(JSON)  # List of technical terms
    action_items = Column(JSON)  # List of action items
    created_at = Column(DateTime, default=datetime.utcnow)
    glossary_domain = Column(String(100), nullable=True)
    glossary_version_id = Column(Integer, nullable=True)
    glossary_version_hash = Column(String(64), nullable=True)

    # Foreign key
    transcript_id = Column(Integer, ForeignKey("transcripts.id"))
    transcript = relationship("Transcript", back_populates="analysis")


class MeetingAnalysisRun(Base):
    __tablename__ = "meeting_analysis_runs"
    __table_args__ = (
        Index(
            "ix_meeting_analysis_runs_meeting_status_updated",
            "meeting_id",
            "status",
            "updated_at",
        ),
        Index(
            "ix_meeting_analysis_runs_cache_lookup",
            "meeting_id",
            "canonical_transcript_hash",
            "prompt_version",
            "schema_version",
            "provider",
            "model",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(BigInteger, nullable=False, index=True)
    owner_id = Column(String(128), nullable=True, index=True)
    status = Column(String(32), nullable=False, index=True)
    provider = Column(String(32), nullable=False)
    model = Column(String(128), nullable=False)
    prompt_version = Column(String(64), nullable=False)
    schema_version = Column(String(64), nullable=False)
    canonical_transcript_hash = Column(String(64), nullable=True, index=True)
    canonical_transcript_version = Column(String(64), nullable=True)
    speaker_stabilization_version = Column(String(64), nullable=True)
    recognition_mode = Column(String(64), nullable=True)
    transcript_language = Column(String(16), nullable=True)
    analysis_input_mode = Column(String(64), nullable=False)
    analysis_payload_json = Column(JSON, nullable=True)
    summary = Column(Text, nullable=True)
    error_code = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    idempotency_key = Column(String(256), nullable=False, unique=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    completed_at = Column(DateTime, nullable=True)
    requested_by = Column(String(128), nullable=True)
    rerun_reason = Column(Text, nullable=True)


class GlossaryEntry(Base):
    __tablename__ = "glossary_entries"

    id = Column(Integer, primary_key=True, index=True)
    term = Column(String(255), nullable=False)
    domain = Column(String(100), nullable=True)
    normalized = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class GlossaryVersion(Base):
    __tablename__ = "glossary_versions"

    id = Column(Integer, primary_key=True, index=True)
    domain = Column(String(100), nullable=True)
    version_hash = Column(String(64), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
