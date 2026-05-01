from sqlalchemy import (
    Column,
    Integer,
    BigInteger,
    String,
    Text,
    DateTime,
    Float,
    ForeignKey,
    JSON,
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

    # Relationship
    analysis = relationship("Analysis", back_populates="transcript", uselist=False)


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
