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
    PrimaryKeyConstraint,
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
        Index(
            "ix_transcript_fragments_v2_event_identity",
            "meeting_id",
            "recording_session_id",
            "attempt_id",
            "stream_id",
            "seq",
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    meeting_id = Column(BigInteger, nullable=False, index=True)
    recording_session_id = Column(BigInteger, nullable=True)
    attempt_id = Column(BigInteger, nullable=True)
    stream_id = Column(String(8), nullable=False, default="", index=True)
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
    __table_args__ = (PrimaryKeyConstraint("meeting_id", "stream_id"),)

    meeting_id = Column(BigInteger, primary_key=True, index=True)
    stream_id = Column(String(8), primary_key=True, default="", nullable=False)
    last_ack_seq = Column(Integer, nullable=False, default=0)
    last_persisted_seq = Column(Integer, nullable=False, default=0)
    last_finalized_seq = Column(Integer, nullable=False, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class TranscriptAttemptCheckpoint(Base):
    __tablename__ = "transcript_attempt_checkpoints"
    __table_args__ = (
        PrimaryKeyConstraint(
            "meeting_id",
            "recording_session_id",
            "attempt_id",
            "stream_id",
            name="transcript_attempt_checkpoints_pkey",
        ),
        Index(
            "ix_transcript_attempt_checkpoints_meeting_session_stream",
            "meeting_id",
            "recording_session_id",
            "stream_id",
        ),
    )

    meeting_id = Column(BigInteger, primary_key=True)
    recording_session_id = Column(BigInteger, primary_key=True)
    attempt_id = Column(BigInteger, primary_key=True)
    stream_id = Column(String(8), primary_key=True, default="", nullable=False)
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
    recording_session_id = Column(BigInteger, nullable=True)
    attempt_id = Column(BigInteger, nullable=True)
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
    analysis_retry_count = Column(Integer, nullable=False, default=0)
    analysis_next_retry_at = Column(DateTime, nullable=True)
    analysis_last_attempt_at = Column(DateTime, nullable=True)
    analysis_provider_alias = Column(String(32), nullable=True)
    analysis_trace_id = Column(String(64), nullable=True)
    analysis_input_hash = Column(String(64), nullable=True)
    canonical_transcript_rows = Column(JSON, nullable=True)
    evidence_stats = Column(JSON, nullable=True)


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


class SubjectSynthesis(Base):
    __tablename__ = "subject_synthesis"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    subject_id = Column(BigInteger, nullable=False, index=True)
    owner_user_id = Column(BigInteger, nullable=False, index=True)
    status = Column(String(30), nullable=False, index=True)
    version = Column(Integer, nullable=False, default=1)
    title = Column(String(255), nullable=True)
    content_json = Column(JSON, nullable=True)
    options_json = Column(JSON, nullable=True)
    source_hash = Column(String(64), nullable=False)
    options_hash = Column(String(64), nullable=True)
    source_selection_mode = Column(String(20), nullable=False, default="ALL_READY")
    prompt_version = Column(String(100), nullable=True)
    schema_version = Column(String(100), nullable=True)
    idempotency_key = Column(String(256), nullable=False)
    generation_request_id = Column(String(64), nullable=True)
    error_code = Column(String(100), nullable=True)
    error_message = Column(Text, nullable=True)
    warnings_json = Column(JSON, nullable=True)
    generated_at = Column(DateTime, nullable=True)
    dispatch_requested_at = Column(DateTime, nullable=True)
    celery_task_id = Column(String(128), nullable=True)
    processing_started_at = Column(DateTime, nullable=True)
    attempt_count = Column(Integer, nullable=False, default=0)
    last_heartbeat_at = Column(DateTime, nullable=True)
    quota_confirmed_at = Column(DateTime, nullable=True)
    dispatch_attempt_count = Column(Integer, nullable=False, default=0)
    last_dispatch_error = Column(Text, nullable=True)
    last_dispatch_error_at = Column(DateTime, nullable=True)
    next_dispatch_retry_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    deleted_at = Column(DateTime, nullable=True)

    sources = relationship(
        "SubjectSynthesisSource",
        back_populates="synthesis",
        cascade="all, delete-orphan",
    )


class SubjectSynthesisSource(Base):
    __tablename__ = "subject_synthesis_source"
    __table_args__ = (PrimaryKeyConstraint("synthesis_id", "meeting_id"),)

    synthesis_id = Column(
        BigInteger, ForeignKey("subject_synthesis.id", ondelete="CASCADE"), nullable=False
    )
    meeting_id = Column(BigInteger, nullable=False, index=True)
    transcript_hash = Column(String(64), nullable=True)
    analysis_run_id = Column(BigInteger, nullable=True)
    analysis_version = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    synthesis = relationship("SubjectSynthesis", back_populates="sources")


class StudyArtifact(Base):
    __tablename__ = "study_artifact"

    id = Column(BigInteger, primary_key=True, index=True, autoincrement=True)
    owner_user_id = Column(BigInteger, nullable=False, index=True)
    subject_id = Column(BigInteger, nullable=False, index=True)
    synthesis_id = Column(BigInteger, nullable=True)
    artifact_type = Column(String(40), nullable=False, index=True)
    status = Column(String(30), nullable=False, index=True)
    version = Column(Integer, nullable=False, default=1)
    title = Column(String(255), nullable=True)
    options_json = Column(JSON, nullable=True)
    content_json = Column(JSON, nullable=True)
    source_hash = Column(String(64), nullable=False)
    options_hash = Column(String(64), nullable=False)
    source_selection_mode = Column(String(20), nullable=False, default="ALL_READY")
    prompt_version = Column(String(100), nullable=True)
    schema_version = Column(String(100), nullable=True)
    idempotency_key = Column(String(256), nullable=False)
    generation_request_id = Column(String(64), nullable=True)
    error_code = Column(String(100), nullable=True)
    error_message = Column(Text, nullable=True)
    warnings_json = Column(JSON, nullable=True)
    generated_at = Column(DateTime, nullable=True)
    dispatch_requested_at = Column(DateTime, nullable=True)
    celery_task_id = Column(String(128), nullable=True)
    processing_started_at = Column(DateTime, nullable=True)
    attempt_count = Column(Integer, nullable=False, default=0)
    last_heartbeat_at = Column(DateTime, nullable=True)
    quota_confirmed_at = Column(DateTime, nullable=True)
    dispatch_attempt_count = Column(Integer, nullable=False, default=0)
    last_dispatch_error = Column(Text, nullable=True)
    last_dispatch_error_at = Column(DateTime, nullable=True)
    next_dispatch_retry_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
    deleted_at = Column(DateTime, nullable=True)

    sources = relationship(
        "StudyArtifactSource",
        back_populates="artifact",
        cascade="all, delete-orphan",
    )


class StudyArtifactSource(Base):
    __tablename__ = "study_artifact_source"
    __table_args__ = (PrimaryKeyConstraint("artifact_id", "meeting_id"),)

    artifact_id = Column(
        BigInteger, ForeignKey("study_artifact.id", ondelete="CASCADE"), nullable=False
    )
    meeting_id = Column(BigInteger, nullable=False, index=True)
    transcript_hash = Column(String(64), nullable=True)
    analysis_run_id = Column(BigInteger, nullable=True)
    analysis_version = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    artifact = relationship("StudyArtifact", back_populates="sources")
