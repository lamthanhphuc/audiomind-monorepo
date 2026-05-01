from pydantic import BaseModel
from typing import Dict, List, Optional
from datetime import datetime


class TranscriptSegment(BaseModel):
    speaker: str
    start_time: float
    end_time: float
    text: str


class ActionItem(BaseModel):
    task: str
    owner: Optional[str] = None
    deadline: Optional[str] = None


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
    technical_terms: List[str]
    action_items: List[ActionItem]
    created_at: datetime

    class Config:
        from_attributes = True
