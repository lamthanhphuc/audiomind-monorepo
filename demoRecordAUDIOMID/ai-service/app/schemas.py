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
    dueDate: Optional[str] = None
    deadline: Optional[str] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    evidence: Optional[str] = None
    evidenceQuote: Optional[str] = None
    evidenceKeywords: List[str] = []


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
    transcriptMode: Optional[str] = None
    canonicalTranscriptVersion: Optional[str] = None
    canonicalTranscriptHash: Optional[str] = None
    canonicalGeneratedAt: Optional[datetime] = None
    rawTranscripts: Optional[List[TranscriptSegment]] = None

    class Config:
        from_attributes = True


class AnalysisResponse(BaseModel):
    meeting_id: int
    summary: str
    meetingSummary: Optional[str] = None
    keywords: List[str]
    technical_terms: List[Any]
    action_items: List[ActionItem]
    businessActionItems: List[ActionItem] = []
    keyDecisions: List[str] = []
    risks: List[str] = []
    blockers: List[str] = []
    questions: List[str] = []
    deadlines: List[str] = []
    owners: List[str] = []
    nextSteps: List[str] = []
    businessImpact: Optional[str] = None
    customerImpact: Optional[str] = None
    technicalImpact: Optional[str] = None
    confidence: Optional[float] = None
    promptVersion: Optional[str] = None
    schemaVersion: Optional[str] = None
    analysisFeatureSet: Optional[str] = None
    groupedActionPlan: Optional[Dict[str, Any]] = None
    created_at: datetime
    technicalTerms: List[AnalysisTechnicalTerm] = []
    painPoints: List[AnalysisPainPoint] = []
    actionItems: List[str] = []
    domainMode: str = "it"
    status: Optional[str] = None
    source: Optional[str] = None
    transcript_hash: Optional[str] = None
    analysisStatus: Optional[str] = None
    cacheHit: Optional[bool] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    canonicalTranscriptHash: Optional[str] = None
    canonicalTranscriptVersion: Optional[str] = None
    analysisInputMode: Optional[str] = None
    lastAnalyzedAt: Optional[datetime] = None
    stale: Optional[bool] = None
    staleReason: Optional[str] = None
    retryAfterSeconds: Optional[int] = None

    class Config:
        from_attributes = True


class RealtimeTranscriptAnalysisRequest(BaseModel):
    meeting_id: int
    transcript: str
    domain_mode: Optional[str] = "it"
    source: Optional[str] = "realtime"
    transcript_hash: Optional[str] = None
    prompt_version: Optional[str] = None
    schema_version: Optional[str] = None
    analysis_feature_set: Optional[str] = None
    mode: Optional[str] = "auto"
    reason: Optional[str] = None


class AnalysisRerunRequest(BaseModel):
    mode: Optional[str] = "force"
    reason: Optional[str] = None
    transcript: Optional[str] = None
    transcript_hash: Optional[str] = None
    prompt_version: Optional[str] = None
    schema_version: Optional[str] = None
    analysis_feature_set: Optional[str] = None
    canonical_transcript_hash: Optional[str] = None
    canonical_transcript_version: Optional[str] = None


class RealtimeTranscriptAnalysisResponse(BaseModel):
    meeting_id: int
    status: str
    analysis: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None
    transcript_hash: Optional[str] = None
    source: Optional[str] = None
    promptVersion: Optional[str] = None
    schemaVersion: Optional[str] = None
    analysisFeatureSet: Optional[str] = None
    retryAfterSeconds: Optional[int] = None
    errorCode: Optional[str] = None
    analysisStatus: Optional[str] = None
    cacheHit: Optional[bool] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    canonicalTranscriptHash: Optional[str] = None
    canonicalTranscriptVersion: Optional[str] = None
    analysisInputMode: Optional[str] = None
    lastAnalyzedAt: Optional[datetime] = None
    stale: Optional[bool] = None
    staleReason: Optional[str] = None


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
