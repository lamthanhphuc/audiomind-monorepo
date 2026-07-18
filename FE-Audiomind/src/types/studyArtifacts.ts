import type { StudyJobStatus, StudySourceRef, StudySourceSelectionMode } from './subjectSynthesis'

export type StudyArtifactType =
  | 'MIND_MAP'
  | 'FLASHCARDS'
  | 'MULTIPLE_CHOICE'
  | 'ESSAY_QUESTIONS'
  | 'EXAM_BRIEF'

export type AggregateStudyStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'PARTIALLY_FAILED'
  | 'FAILED'

export type StudyArtifactOptions = {
  language?: string
  difficulty?: 'EASY' | 'MEDIUM' | 'HARD' | 'MIXED' | string
  flashcardCount?: number
  multipleChoiceCount?: number
  essayQuestionCount?: number
}

export type MindMapRoot = {
  id: string
  label: string
  type?: string
}

export type MindMapNode = {
  id: string
  parentId?: string | null
  label: string
  description?: string | null
  type?: string
  sourceMeetingIds?: number[]
  sourceSegmentIds?: string[]
}

export type MindMapEdge = {
  source: string
  target: string
  relation?: string
}

export type MindMapContent = {
  root: MindMapRoot
  nodes: MindMapNode[]
  edges: MindMapEdge[]
}

export type Flashcard = {
  id: string
  front: string
  back: string
  hint?: string | null
  tags?: string[]
  difficulty?: string
  sourceMeetingIds?: number[]
  sourceSegmentIds?: string[]
}

export type FlashcardsContent = {
  cards: Flashcard[]
}

export type McqOption = {
  id: string
  text: string
}

export type McqQuestion = {
  id: string
  question: string
  options: McqOption[]
  correctOptionId: string
  explanation?: string
  difficulty?: string
  sourceMeetingIds?: number[]
  sourceSegmentIds?: string[]
}

export type MultipleChoiceContent = {
  questions: McqQuestion[]
}

export type RubricItem = {
  criterion: string
  points: number
}

export type EssayQuestion = {
  id: string
  question: string
  suggestedOutline?: string[]
  keyPoints?: string[]
  rubric?: RubricItem[]
  difficulty?: string
  sourceMeetingIds?: number[]
  sourceSegmentIds?: string[]
}

export type EssayContent = {
  questions: EssayQuestion[]
}

export type ExamBriefContent = {
  overview: string
  mustRemember: string[]
  importantTerms: string[]
  formulas: string[]
  commonMistakes: string[]
  likelyExamTopics: string[]
  lastMinuteChecklist: string[]
  sourceMeetingIds?: number[]
}

export type StudyArtifactContent =
  | MindMapContent
  | FlashcardsContent
  | MultipleChoiceContent
  | EssayContent
  | ExamBriefContent

export type StudyArtifact = {
  id: number
  subjectId: number
  ownerUserId?: number
  synthesisId?: number | null
  artifactType: StudyArtifactType | string
  status: StudyJobStatus | string
  version: number
  title?: string | null
  options?: StudyArtifactOptions | null
  content?: StudyArtifactContent | null
  sourceHash?: string | null
  optionsHash?: string | null
  sourceSelectionMode?: StudySourceSelectionMode | string
  promptVersion?: string | null
  schemaVersion?: string | null
  generationRequestId?: string | null
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

export type CreateStudyArtifactsRequest = {
  subjectId: number
  meetingIds?: number[]
  artifactTypes: StudyArtifactType[]
  sourceSelectionMode?: StudySourceSelectionMode
  options?: StudyArtifactOptions
  synthesisId?: number | null
  force?: boolean
}

export type StudyArtifactsCreateResponse = {
  artifactIds: number[]
  newlyCreatedArtifactIds?: number[]
  cacheHitArtifactIds?: number[]
  inFlightArtifactIds?: number[]
  artifacts: StudyArtifact[]
  status: AggregateStudyStatus | string
  generationRequestId?: string | null
}

export const STUDY_ARTIFACT_TERMINAL_SUCCESS = new Set(['COMPLETED', 'STALE'])
export const STUDY_ARTIFACT_TERMINAL_FAILURE = new Set(['FAILED', 'QUOTA_EXCEEDED'])

export const isStudyArtifactTerminal = (status: string): boolean => {
  const normalized = status.trim().toUpperCase()
  return STUDY_ARTIFACT_TERMINAL_SUCCESS.has(normalized) || STUDY_ARTIFACT_TERMINAL_FAILURE.has(normalized)
}

/** Aggregate per-artifact statuses client-side (locked Phase 2 enum). */
export const aggregateStudyStatuses = (statuses: string[]): AggregateStudyStatus => {
  if (statuses.length === 0) {
    return 'FAILED'
  }
  const normalized = statuses.map((s) => s.trim().toUpperCase())
  if (normalized.some((s) => s === 'PROCESSING')) {
    return 'PROCESSING'
  }
  if (normalized.some((s) => s === 'QUEUED')) {
    return 'QUEUED'
  }
  const failures = normalized.filter((s) => STUDY_ARTIFACT_TERMINAL_FAILURE.has(s))
  const successes = normalized.filter((s) => STUDY_ARTIFACT_TERMINAL_SUCCESS.has(s))
  if (failures.length > 0 && successes.length > 0) {
    return 'PARTIALLY_FAILED'
  }
  if (failures.length > 0 && successes.length === 0) {
    return 'FAILED'
  }
  if (successes.length > 0 && failures.length === 0) {
    return 'COMPLETED'
  }
  return 'PROCESSING'
}
