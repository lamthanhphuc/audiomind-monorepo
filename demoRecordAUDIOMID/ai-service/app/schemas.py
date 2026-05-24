from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class TranscriptSegment(BaseModel):
    speaker: str
    start_time: float
    end_time: float
    text: str
    segment_id: Optional[str] = None


class ActionItem(BaseModel):
    task: str
    owner: Optional[str] = None
    deadline: Optional[str] = None


class AnalysisTechnicalTerm(BaseModel):
    term: str
    meaning: str = ""
    category: str = ""


class AnalysisPainPoint(BaseModel):
    title: str
    evidence: str = ""
    severity: str = "medium"


class MeetingAnalysis(BaseModel):
    summary: str
    keywords: List[str]
    technical_terms: List[str]
    action_items: List[ActionItem]


class GlossaryReference(BaseModel):
    glossary_id: int
    domain: Optional[str] = None
    version_hash: Optional[str] = None


class GlossaryEntryCreate(BaseModel):
    term: str
    domain: Optional[str] = None
    normalized: Optional[str] = None


class GlossaryEntryUpdate(BaseModel):
    term: Optional[str] = None
    domain: Optional[str] = None
    normalized: Optional[str] = None


class GlossaryEntryResponse(BaseModel):
    id: int
    term: str
    domain: Optional[str] = None
    normalized: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


class GlossarySnapshotResponse(BaseModel):
    domain: Optional[str] = None
    version_hash: str
    version_id: Optional[int] = None
    terms: List[str]
    topic_defaults: Dict[str, List[str]]
    normalization_map: Dict[str, str]


class ProcessRequest(BaseModel):
    meeting_id: int
    audio_path: str
    file_id: Optional[str] = None
    trace_id: Optional[str] = None
    topic: Optional[str] = None
    glossary_terms: Optional[List[str]] = None
    glossary_ref: Optional[GlossaryReference] = None
    language: Optional[str] = "vi"


class ProcessResponse(BaseModel):
    meeting_id: int
    status: str
    message: str


class TranscriptResponse(BaseModel):
    meeting_id: int
    transcripts: List[TranscriptSegment]

    class Config:
        from_attributes = True


class AnalysisResponse(BaseModel):
    meeting_id: int
    summary: str
    keywords: List[str]
    technical_terms: List[Any]
    action_items: List[ActionItem]
    created_at: datetime
    technicalTerms: List[AnalysisTechnicalTerm] = []
    painPoints: List[AnalysisPainPoint] = []
    actionItems: List[str] = []
    domainMode: str = "it"
    status: Optional[str] = None
    source: Optional[str] = None
    transcript_hash: Optional[str] = None

    class Config:
        from_attributes = True


class RealtimeTranscriptAnalysisRequest(BaseModel):
    meeting_id: int
    transcript: str
    domain_mode: Optional[str] = "it"
    source: Optional[str] = "realtime"
    transcript_hash: Optional[str] = None


class RealtimeTranscriptAnalysisResponse(BaseModel):
    meeting_id: int
    status: str
    reason: Optional[str] = None
    transcript_hash: Optional[str] = None
    source: Optional[str] = None


class SttStreamResponse(BaseModel):
    transcript: str
    is_final: bool
    confidence: Optional[float] = None
    speaker: Optional[str] = None
    segment_id: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    finalized: Optional[bool] = None
    partial: Optional[bool] = None
    reset_required: Optional[bool] = None
