export type StudySourceSelectionMode = 'ALL_READY' | 'EXPLICIT'

export type StudyJobStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'STALE'
  | 'QUOTA_EXCEEDED'

export type StudySourceRef = {
  meetingId: number
  transcriptHash?: string | null
  analysisRunId?: number | null
  analysisVersion?: string | null
}

export type EvidencePair = {
  meetingId: number
  segmentId: string
}

export type EvidencedItem = {
  content: string
  importance?: string
  reason?: string | null
  evidence?: EvidencePair[]
  sourceMeetingIds?: number[]
  sourceSegmentIds?: string[]
}

export type GlossaryItem = {
  term: string
  definition: string
  example?: string | null
  evidence?: EvidencePair[]
  sourceMeetingIds?: number[]
  sourceSegmentIds?: string[]
}

export type SynthesisChapter = {
  id: string
  title: string
  summary: string
  keyPoints?: EvidencedItem[]
  keywords?: string[]
  glossary?: GlossaryItem[]
  mustRemember?: EvidencedItem[]
  evidence?: EvidencePair[]
  sourceMeetingIds?: number[]
  sourceSegmentIds?: string[]
}

export type KnowledgeGap = {
  content: string
  reason: string
  evidence?: EvidencePair[]
  sourceMeetingIds?: number[]
  sourceSegmentIds?: string[]
}

export type ExamFocus = {
  content: string
  reason: string
  evidence?: EvidencePair[]
  sourceMeetingIds?: number[]
  sourceSegmentIds?: string[]
}

export type SubjectSynthesisContent = {
  subjectOverview: string
  learningObjectives: string[]
  chapters: SynthesisChapter[]
  importantTerms: GlossaryItem[]
  mustRemember: EvidencedItem[]
  knowledgeGaps: KnowledgeGap[]
  examFocus: ExamFocus[]
}

export type SubjectSynthesis = {
  id: number
  subjectId: number
  ownerUserId?: number
  status: StudyJobStatus | string
  version: number
  title?: string | null
  content?: SubjectSynthesisContent | null
  sourceHash?: string | null
  optionsHash?: string | null
  sourceSelectionMode?: StudySourceSelectionMode | string
  promptVersion?: string | null
  schemaVersion?: string | null
  errorCode?: string | null
  errorMessage?: string | null
  warnings?: unknown
  generatedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  sourceMeetingIds?: number[]
  sources?: StudySourceRef[]
  stale?: boolean
  cacheHit?: boolean
}

export type CreateSubjectSynthesisRequest = {
  meetingIds?: number[]
  sourceSelectionMode?: StudySourceSelectionMode
  language?: string
  force?: boolean
}

export type SubjectSynthesisPrepareResponse = {
  kind?: string
  newlyCreated?: SubjectSynthesis[]
  cacheHits?: SubjectSynthesis[]
  inFlight?: SubjectSynthesis[]
  synthesis: SubjectSynthesis
  status?: string
}
