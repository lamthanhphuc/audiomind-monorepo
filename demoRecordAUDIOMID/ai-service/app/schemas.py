from pydantic import BaseModel
from typing import List, Optional
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


class ProcessRequest(BaseModel):
    meeting_id: int
    audio_path: str
    topic: Optional[str] = None
    glossary_terms: Optional[List[str]] = None
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
