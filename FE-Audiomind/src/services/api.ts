import {
  normalizeResultScopeItem,
  type MeetingResultScope,
  type MeetingResultScopeItem,
} from '../utils/meetingResultScope'
import type { paths as MeetingPaths } from '../../../packages/api-clients/meeting'
import type { paths as ProcessingPaths } from '../../../packages/api-clients/processing'
import {
  normalizeAnalysisResponse,
  normalizeGroupedActionPlan,
  type AiAnalysis,
  type GroupedActionPlan,
  type Meeting,
  type TranscriptResponse,
} from '../types'
import { getAccessToken } from './auth'
import { API_BASE, MEETING_API_BASE, PROCESSING_API_BASE, USER_API_BASE } from './config'

const isApiDebugLoggingEnabled = (): boolean => {
  if (import.meta.env.VITE_API_DEBUG === 'true') {
    return true
  }

  try {
    return window.localStorage.getItem('audiomind.api.debug') === 'true'
  } catch {
    return false
  }
}

type CreateMeetingResponse =
  MeetingPaths['/api/v1/meetings']['post']['responses'][200]['content']['application/json']

type GetMeetingResponse =
  MeetingPaths['/api/v1/meetings/{id}']['get']['responses'][200]['content']['application/json']

type CreateJobRequest =
  ProcessingPaths['/api/v1/jobs']['post']['requestBody']['content']['application/json']

export type AnalysisRerunRequest = {
  mode: 'force' | string
  reason: 'manual_reanalyze' | string
  domainMode?: string
  domain_mode?: string
}

export type TranscriptEvidenceContext = {
  segmentId: string
  index: number
  speaker: string
  startTime: number
  endTime: number
  text: string
  textTruncated: boolean
}

export type TranscriptEvidenceMatch = TranscriptEvidenceContext & {
  evidenceId: string
  contextBefore: TranscriptEvidenceContext[]
  contextAfter: TranscriptEvidenceContext[]
  score: number
  rank: number
  matchType: 'phrase' | 'token' | string
  verificationStatus?: string | null
  dedupeKey?: string | null
}

export type TranscriptSearchResponse = {
  meetingId: number
  query: string
  normalizedQuery: string
  transcriptMode: 'canonical' | 'raw' | string
  canonicalTranscriptHash?: string | null
  canonicalTranscriptVersion?: string | null
  matches: TranscriptEvidenceMatch[]
}

export type SearchTranscriptEvidenceOptions = {
  limit?: number
  context?: number
}

export type MeetingActionPlanData = {
  meeting: {
    meetingId: number
    title?: string | null
    createdAt?: string | null
    language?: string | null
    status?: string | null
    originalFileName?: string | null
    ownerUserId?: string | number | null
  }
  summary?: string | null
  domainMode?: string | null
  actionItems: ActionPlanItem[]
  painPoints: Array<{
    title: string
    severity?: string | null
    evidence?: string | null
  }>
  risks: string[]
  blockers: string[]
  groupedActionPlan?: GroupedActionPlan | null
  generatedAt?: string | null
  note?: string | null
  analysisMetadata: {
    provider?: string | null
    model?: string | null
    promptVersion?: string | null
    schemaVersion?: string | null
    analysisSource?: string | null
    cacheOnly?: boolean | null
    stale?: boolean | null
    canonicalTranscriptHash?: string | null
    canonicalTranscriptVersion?: string | null
    analysisFeatureSet?: string | null
  }
}

export type ActionPlanItem = {
  task: string
  owner?: string | null
  deadline?: string | null
  dueDate?: string | null
  priority?: 'low' | 'medium' | 'high' | string | null
  status?: 'open' | 'in_progress' | 'blocked' | 'done' | string | null
  evidenceKeywords?: string[]
  evidenceQuote?: string | null
  evidence?: TranscriptEvidenceMatch | null
  unverifiedEvidenceNote?: string | null
}

const normalizeActionPlanItems = (value: unknown): ActionPlanItem[] => {
  return Array.isArray(value)
    ? value.map((item) => {
      if (typeof item === 'string') {
        return { task: item.trim(), evidenceKeywords: [] }
      }
      const record = item && typeof item === 'object'
        ? (item as Partial<ActionPlanItem> & Record<string, unknown>)
        : {}
      return {
        ...record,
        task: firstString(record.task, record.description, record.text, record.title) ?? '',
        evidenceKeywords: Array.isArray(record.evidenceKeywords)
          ? (record.evidenceKeywords as string[])
          : Array.isArray(record.evidence_keywords)
            ? (record.evidence_keywords as string[])
            : [],
      }
    }).filter((item) => item.task)
    : []
}

export const normalizeMeetingActionPlanData = (value: unknown): MeetingActionPlanData => {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
  const meeting = payload.meeting && typeof payload.meeting === 'object' && !Array.isArray(payload.meeting)
    ? (payload.meeting as MeetingActionPlanData['meeting'])
    : { meetingId: firstNumber(payload.meetingId, payload.meeting_id) ?? 0 }
  const actionItems = normalizeActionPlanItems(payload.actionItems ?? payload.action_items)
  const groupedActionPlan = normalizeGroupedActionPlan(
    payload.groupedActionPlan ?? payload.grouped_action_plan,
    actionItems,
  )
  const metadata = payload.analysisMetadata && typeof payload.analysisMetadata === 'object' && !Array.isArray(payload.analysisMetadata)
    ? (payload.analysisMetadata as MeetingActionPlanData['analysisMetadata'])
    : {}

  return {
    meeting,
    summary: firstString(payload.summary) ?? null,
    domainMode: firstString(payload.domainMode, payload.domain_mode) ?? null,
    actionItems,
    painPoints: Array.isArray(payload.painPoints) ? (payload.painPoints as MeetingActionPlanData['painPoints']) : [],
    risks: Array.isArray(payload.risks) ? (payload.risks as string[]) : [],
    blockers: Array.isArray(payload.blockers) ? (payload.blockers as string[]) : [],
    groupedActionPlan: groupedActionPlan ?? null,
    generatedAt: firstString(payload.generatedAt, payload.generated_at) ?? null,
    note: firstString(payload.note) ?? null,
    analysisMetadata: {
      ...metadata,
      analysisFeatureSet: firstString(
        metadata.analysisFeatureSet,
        (metadata as Record<string, unknown>).analysis_feature_set,
        payload.analysisFeatureSet,
        payload.analysis_feature_set,
      ) ?? metadata.analysisFeatureSet ?? null,
    },
  }
}

export class ApiError extends Error {
  status: number

  traceId?: string

  errorCode?: string

  retryAfterSeconds?: number

  constructor(message: string, status: number, traceId?: string, errorCode?: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.traceId = traceId
    this.errorCode = errorCode
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const normalized = String(value ?? '').trim()
    if (normalized) {
      return normalized
    }
  }
  return undefined
}

const firstNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    const normalized = String(value ?? '').trim()
    if (!normalized) {
      continue
    }
    const parsed = Number(normalized)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

const parseRetryAfterFromText = (value: string): number | undefined => {
  const match = value.match(/retryAfterSeconds=(\d+)/i)
  if (!match?.[1]) {
    return undefined
  }
  return firstNumber(match[1])
}

const parseApiErrorResponse = async (response: Response): Promise<ApiError> => {
  const text = await response.text()
  const traceId = response.headers.get('x-trace-id') ?? response.headers.get('x-request-id') ?? undefined
  let message = text || response.statusText
  let errorCode: string | undefined
  let bodyTraceId: string | undefined
  let retryAfterSeconds: number | undefined

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const detail = parsed.detail && typeof parsed.detail === 'object' && !Array.isArray(parsed.detail)
      ? (parsed.detail as Record<string, unknown>)
      : null
    message = firstString(
      typeof parsed.detail === 'string' ? parsed.detail : undefined,
      detail?.message,
      detail?.detail,
      parsed.message,
      message,
    ) ?? message
    errorCode = firstString(parsed.errorCode, parsed.error_code, parsed.error, detail?.errorCode, detail?.error_code, detail?.error)
    bodyTraceId = firstString(parsed.traceId, parsed.trace_id)
    retryAfterSeconds = firstNumber(
      parsed.retryAfterSeconds,
      parsed.retry_after_seconds,
      detail?.retryAfterSeconds,
      detail?.retry_after_seconds,
    )
  } catch {
    // Use raw text when response is not JSON.
  }

  retryAfterSeconds = retryAfterSeconds ?? parseRetryAfterFromText(message)
  return new ApiError(message, response.status, traceId ?? bodyTraceId, errorCode, retryAfterSeconds)
}

const fetchJsonNoConsole = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, {
    ...init,
    headers: withTraceHeaders(init?.headers),
  })
  if (!response.ok) {
    throw await parseApiErrorResponse(response)
  }
  return response.json() as Promise<T>
}

const createTraceId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const withTraceHeaders = (headers?: HeadersInit): Headers => {
  const merged = new Headers(headers ?? {})

  const accessToken = getAccessToken()
  if (accessToken && !merged.has('Authorization')) {
    merged.set('Authorization', `Bearer ${accessToken}`)
  }

  if (!merged.has('x-trace-id')) {
    merged.set('x-trace-id', createTraceId())
  }
  if (!merged.has('x-request-id')) {
    merged.set('x-request-id', merged.get('x-trace-id') ?? createTraceId())
  }
  return merged
}

const fetchJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, {
    ...init,
    headers: withTraceHeaders(init?.headers),
  })
  if (!response.ok) {
    const text = await response.text()
    const traceId = response.headers.get('x-trace-id') ?? response.headers.get('x-request-id') ?? undefined
    let message = text || response.statusText
    let errorCode: string | undefined
    let retryAfterSeconds: number | undefined

    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const detail = parsed.detail && typeof parsed.detail === 'object' && !Array.isArray(parsed.detail)
        ? (parsed.detail as Record<string, unknown>)
        : null
      message = firstString(
        typeof parsed.detail === 'string' ? parsed.detail : undefined,
        detail?.message,
        detail?.detail,
        parsed.message,
        message,
      ) ?? message
      errorCode = firstString(parsed.errorCode, parsed.error_code, detail?.errorCode, detail?.error_code)
      retryAfterSeconds = firstNumber(
        parsed.retryAfterSeconds,
        parsed.retry_after_seconds,
        detail?.retryAfterSeconds,
        detail?.retry_after_seconds,
      )
    } catch {
      // Use raw text when response is not JSON.
    }
    retryAfterSeconds = retryAfterSeconds ?? parseRetryAfterFromText(message)

    const safePath = (() => {
      try {
        return new URL(String(input), window.location.origin).pathname
      } catch {
        return 'unknown'
      }
    })()

    if (isApiDebugLoggingEnabled()) {
      console.error('API request failed', {
        path: safePath,
        status: response.status,
        statusText: response.statusText,
        errorCode,
        traceId,
        retryAfterSeconds,
      })
    }
    throw new ApiError(message, response.status, traceId, errorCode, retryAfterSeconds)
  }
  return response.json() as Promise<T>
}

const parseFilenameFromContentDisposition = (headerValue: string | null): string | null => {
  if (!headerValue) {
    return null
  }

  const utf8Match = headerValue.match(/filename\\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).replace(/^\"|\"$/g, '')
    } catch {
      return utf8Match[1].replace(/^\"|\"$/g, '')
    }
  }

  const asciiMatch = headerValue.match(/filename=([^;]+)/i)
  if (asciiMatch?.[1]) {
    return asciiMatch[1].trim().replace(/^\"|\"$/g, '')
  }

  return null
}

export const processAudio = async (payload: {
  meeting_id: number
  audio_path: string
  topic?: string
  glossary_terms?: string[]
  language?: string
}) => {
  return fetchJson<Record<string, unknown>>(`${API_BASE}/processing/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export const uploadAudio = async (file: File): Promise<{ audio_path: string; original_filename: string }> => {
  const body = new FormData()
  body.append('file', file)

  return fetchJson<{ audio_path: string; original_filename: string }>(`${API_BASE}/processing/upload`, {
    method: 'POST',
    headers: withTraceHeaders(),
    body,
  })
}

export type RealtimeFinalAudioFallbackResponse = {
  meeting_id: number
  status: string
  errorCode?: string
  transcript_count?: number
  transcriptRows?: number
  idempotent_replay?: boolean
  finalized?: boolean
  legacyErrorCode?: string
  analysisStatus?: string
  analysis?: Record<string, unknown>
}

export const submitRealtimeFinalAudioFallback = async (
  meetingId: number,
  file: File,
  language?: string,
): Promise<RealtimeFinalAudioFallbackResponse> => {
  const body = new FormData()
  body.append('file', file)
  const params = new URLSearchParams()
  if (language && language.trim()) {
    params.set('language', language.trim())
  }
  const query = params.toString()
  const url = `${API_BASE}/processing/realtime/${meetingId}/final-audio-fallback${query ? `?${query}` : ''}`
  return fetchJson<RealtimeFinalAudioFallbackResponse>(url, {
    method: 'POST',
    headers: withTraceHeaders(),
    body,
  })
}

export type ApiRequestOptions = {
  signal?: AbortSignal
}

export type TranscriptScopeOptions = ApiRequestOptions & {
  recordingSessionId?: number | null
  attemptId?: number | null
}

export type AnalysisScopeOptions = ApiRequestOptions & {
  recordingSessionId?: number | null
  attemptId?: number | null
}

const appendProvenanceParams = (
  params: URLSearchParams,
  options: { recordingSessionId?: number | null; attemptId?: number | null },
): void => {
  const hasRecordingSession = options.recordingSessionId !== undefined && options.recordingSessionId !== null
  const hasAttempt = options.attemptId !== undefined && options.attemptId !== null
  if (hasRecordingSession !== hasAttempt) {
    throw new ApiError('Invalid transcript provenance scope', 422, undefined, 'INVALID_PROVENANCE')
  }
  if (hasRecordingSession && hasAttempt) {
    params.set('recording_session_id', String(options.recordingSessionId))
    params.set('attempt_id', String(options.attemptId))
  }
}

const normalizeTranscriptResponse = (
  response: TranscriptResponse | { data?: TranscriptResponse },
): TranscriptResponse => {
  if ('data' in response && response.data) {
    return response.data
  }
  return response as TranscriptResponse
}

export const getTranscript = async (
  meetingId: number,
  options: TranscriptScopeOptions = {},
): Promise<TranscriptResponse> => {
  const params = new URLSearchParams()
  appendProvenanceParams(params, options)
  const query = params.toString()
  const response = await fetchJson<TranscriptResponse | { data?: TranscriptResponse }>(
    `${API_BASE}/processing/${meetingId}/transcript${query ? `?${query}` : ''}`,
    { signal: options.signal },
  )
  return normalizeTranscriptResponse(response)
}

const normalizeResultScopeItems = (value: unknown): MeetingResultScopeItem[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const record = item as Record<string, unknown>
      const scopeKind = String(record.scopeKind ?? record.scope_kind ?? '').trim().toLowerCase()
      return {
        scopeKind: scopeKind === 'legacy' ? 'legacy' : 'v2',
        recordingSessionId: firstNumber(record.recordingSessionId, record.recording_session_id) ?? null,
        attemptId: firstNumber(record.attemptId, record.attempt_id) ?? null,
        finalized: typeof record.finalized === 'boolean' ? record.finalized : undefined,
        updatedAt: firstString(record.updatedAt, record.updated_at) ?? null,
        latestSeq: firstNumber(record.latestSeq, record.latest_seq) ?? null,
      } satisfies MeetingResultScopeItem
    })
}

export const listMeetingResultScopes = async (
  meetingId: number,
  options: ApiRequestOptions = {},
): Promise<MeetingResultScopeItem[]> => {
  const response = await fetchJson<{ scopes?: unknown }>(
    `${API_BASE}/processing/${meetingId}/result-scopes`,
    { signal: options.signal },
  )
  return normalizeResultScopeItems(response.scopes)
}

export const resolveMeetingResultScope = async (
  meetingId: number,
  scope?: Pick<MeetingResultScope, 'recordingSessionId' | 'attemptId'>,
  options: ApiRequestOptions = {},
): Promise<MeetingResultScope> => {
  const params = new URLSearchParams()
  const recordingSessionId = scope?.recordingSessionId
  const attemptId = scope?.attemptId
  if (recordingSessionId != null && attemptId != null) {
    params.set('recording_session_id', String(recordingSessionId))
    params.set('attempt_id', String(attemptId))
  } else if (recordingSessionId != null || attemptId != null) {
    throw new ApiError('Invalid transcript provenance scope', 422, undefined, 'INVALID_PROVENANCE')
  }
  const query = params.toString()
  const response = await fetchJson<Record<string, unknown>>(
    `${API_BASE}/processing/${meetingId}/result-scope${query ? `?${query}` : ''}`,
    { signal: options.signal },
  )
  const normalized = normalizeResultScopeItem(meetingId, {
    scopeKind: String(response.scopeKind ?? response.scope_kind ?? 'legacy') === 'legacy' ? 'legacy' : 'v2',
    recordingSessionId: firstNumber(response.recordingSessionId, response.recording_session_id) ?? null,
    attemptId: firstNumber(response.attemptId, response.attempt_id) ?? null,
    finalized: typeof response.finalized === 'boolean' ? response.finalized : undefined,
    updatedAt: firstString(response.updatedAt, response.updated_at) ?? null,
  })
  return {
    ...normalized,
    ambiguous: typeof response.ambiguous === 'boolean' ? response.ambiguous : undefined,
  }
}

export type { MeetingResultScope, MeetingResultScopeItem }

export const searchMeetingTranscriptEvidence = async (
  meetingId: number,
  query: string,
  options: SearchTranscriptEvidenceOptions = {},
): Promise<TranscriptSearchResponse> => {
  const params = new URLSearchParams()
  params.set('q', query)
  params.set('limit', String(options.limit ?? 20))
  params.set('context', String(options.context ?? 1))
  return fetchJsonNoConsole<TranscriptSearchResponse>(
    `${API_BASE}/processing/${meetingId}/transcript/search?${params.toString()}`,
  )
}

export const getAnalysis = async (
  meetingId: number,
  options: AnalysisScopeOptions = {},
): Promise<AiAnalysis> => {
  const params = new URLSearchParams()
  appendProvenanceParams(params, options)
  const query = params.toString()
  const response = await fetchJson<AiAnalysis | { data?: AiAnalysis } & { status?: string }>(
    `${API_BASE}/processing/${meetingId}/analysis${query ? `?${query}` : ''}`,
    { signal: options.signal },
  )

  const normalized = normalizeAnalysisResponse(response)
  const payload = response && typeof response === 'object' && !Array.isArray(response)
    ? (response as Record<string, unknown>)
    : {}
  const nested = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : payload
  const statusValue = typeof nested.status === 'string'
    ? nested.status
    : typeof payload.status === 'string'
      ? payload.status
      : undefined
  if (statusValue) {
    ;(normalized as AiAnalysis & { status?: string }).status = statusValue
  }
  return normalized
}

export const getSavedAnalysis = async (
  meetingId: number,
  options: AnalysisScopeOptions = {},
): Promise<AiAnalysis> => {
  const params = new URLSearchParams()
  appendProvenanceParams(params, options)
  const query = params.toString()
  const response = await fetchJson<AiAnalysis | { data?: AiAnalysis } & { status?: string }>(
    `${API_BASE}/processing/${meetingId}/analysis/saved${query ? `?${query}` : ''}`,
    { signal: options.signal },
  )

  const normalized = normalizeAnalysisResponse(response)
  const payload = response && typeof response === 'object' && !Array.isArray(response)
    ? (response as Record<string, unknown>)
    : {}
  const nested = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? (payload.data as Record<string, unknown>)
    : payload
  const statusValue = typeof nested.status === 'string'
    ? nested.status
    : typeof payload.status === 'string'
      ? payload.status
      : undefined
  if (statusValue) {
    ;(normalized as AiAnalysis & { status?: string }).status = statusValue
  }
  return normalized
}

export const getMeetingActionPlan = async (meetingId: number): Promise<MeetingActionPlanData> => {
  const response = await fetchJsonNoConsole<unknown>(`${API_BASE}/processing/${meetingId}/action-plan`)
  return normalizeMeetingActionPlanData(response)
}

export const reanalyzeMeetingAnalysis = async (
  meetingId: number,
  request: AnalysisRerunRequest = { mode: 'force', reason: 'manual_reanalyze' },
): Promise<AiAnalysis> => {
  const response = await fetchJson<AiAnalysis | { data?: AiAnalysis }>(
    `${API_BASE}/processing/${meetingId}/analysis/rerun`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  )

  return normalizeAnalysisResponse(response)
}

export const downloadMeetingReport = async (
  meetingId: number,
  format: 'docx' | string = 'docx',
): Promise<{ blob: Blob; filename: string }> => {
  const response = await fetch(
    `${API_BASE}/processing/${meetingId}/report?format=${encodeURIComponent(format)}`,
    {
      method: 'GET',
      headers: withTraceHeaders(),
    },
  )

  if (!response.ok) {
    const text = await response.text()
    const traceId = response.headers.get('x-trace-id') ?? response.headers.get('x-request-id') ?? undefined
    let message = text || response.statusText

    try {
      const parsed = JSON.parse(text) as { detail?: string; message?: string }
      message = parsed.detail || parsed.message || message
    } catch {
      // Use raw text when response is not JSON.
    }

    throw new ApiError(message, response.status, traceId)
  }

  const blob = await response.blob()
  const filename = parseFilenameFromContentDisposition(response.headers.get('content-disposition'))
    || `meeting-${meetingId}-report.${format}`
  return { blob, filename }
}

export const downloadMeetingActionPlan = async (
  meetingId: number,
  format: 'docx' | 'pdf' | string = 'docx',
): Promise<{ blob: Blob; filename: string }> => {
  const response = await fetch(
    `${API_BASE}/processing/${meetingId}/action-plan/export?format=${encodeURIComponent(format)}`,
    {
      method: 'GET',
      headers: withTraceHeaders(),
    },
  )

  if (!response.ok) {
    throw await parseApiErrorResponse(response)
  }

  const blob = await response.blob()
  const filename = parseFilenameFromContentDisposition(response.headers.get('content-disposition'))
    || `meeting-${meetingId}-action-plan.${format}`
  return { blob, filename }
}

/** @deprecated Use downloadMeetingActionPlan */
export const downloadMeetingActionPlanDocx = async (meetingId: number) =>
  downloadMeetingActionPlan(meetingId, 'docx')

export const askMeetingChat = async (
  meetingId: number,
  question: string,
): Promise<{ answer: string; provider?: string; sourceSegments?: Array<{
  speaker: string
  startTime: number
  endTime?: number
  quote: string
  segmentId?: string
  evidenceId?: string
}> }> => {
  const response = await fetchJsonNoConsole<{
    answer?: string
    provider?: string
    source_segments?: unknown
    sourceSegments?: unknown
  }>(
    `${API_BASE}/processing/${meetingId}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    },
  )
  const rawSegments = response.source_segments ?? response.sourceSegments
  const sourceSegments = Array.isArray(rawSegments)
    ? rawSegments
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        speaker: String(item.speaker ?? 'Speaker'),
        startTime: Number(item.startTime ?? item.start_time ?? 0),
        endTime: item.endTime == null && item.end_time == null
          ? undefined
          : Number(item.endTime ?? item.end_time),
        quote: String(item.quote ?? item.text ?? '').trim(),
        segmentId: item.segmentId == null && item.segment_id == null
          ? undefined
          : String(item.segmentId ?? item.segment_id),
        evidenceId: item.evidenceId == null && item.evidence_id == null
          ? undefined
          : String(item.evidenceId ?? item.evidence_id),
      }))
      .filter((item) => item.quote.length > 0)
    : []
  return {
    answer: String(response.answer ?? '').trim(),
    provider: response.provider,
    sourceSegments,
  }
}

export type SemanticSearchResult = {
  meetingId: number
  score?: number
  reason?: string
  title?: string
  originalFileName?: string
}

export const semanticSearchMeetings = async (
  query: string,
  limit = 10,
): Promise<{ query: string; provider?: string; results: SemanticSearchResult[] }> => {
  const response = await fetchJsonNoConsole<{
    query?: string
    provider?: string
    results?: unknown[]
  }>(
    `${API_BASE}/processing/search/semantic?limit=${encodeURIComponent(String(limit))}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    },
  )
  const results = Array.isArray(response.results)
    ? response.results
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        meetingId: Number(item.meetingId ?? item.meeting_id),
        score: item.score == null ? undefined : Number(item.score),
        reason: item.reason == null ? undefined : String(item.reason),
        title: item.title == null ? undefined : String(item.title),
        originalFileName: item.originalFileName == null && item.original_file_name == null
          ? undefined
          : String(item.originalFileName ?? item.original_file_name),
      }))
      .filter((item) => Number.isFinite(item.meetingId))
    : []
  return {
    query: String(response.query ?? query),
    provider: response.provider,
    results,
  }
}

export type CrossMeetingAskResult = {
  question: string
  answer: string
  provider?: string
  meetings: SemanticSearchResult[]
}

export const askCrossMeeting = async (
  question: string,
  limit = 5,
): Promise<CrossMeetingAskResult> => {
  const response = await fetchJsonNoConsole<{
    question?: string
    answer?: string
    provider?: string
    meetings?: unknown[]
  }>(
    `${API_BASE}/processing/cross-meeting/ask?limit=${encodeURIComponent(String(limit))}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    },
  )
  const meetings = Array.isArray(response.meetings)
    ? response.meetings
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        meetingId: Number(item.meetingId ?? item.meeting_id),
        score: item.score == null ? undefined : Number(item.score),
        reason: item.reason == null ? undefined : String(item.reason),
        title: item.title == null ? undefined : String(item.title),
        originalFileName: item.originalFileName == null && item.original_file_name == null
          ? undefined
          : String(item.originalFileName ?? item.original_file_name),
      }))
      .filter((item) => Number.isFinite(item.meetingId))
    : []
  return {
    question: String(response.question ?? question),
    answer: String(response.answer ?? '').trim(),
    provider: response.provider,
    meetings,
  }
}

export const downloadMeetingTranscript = async (
  meetingId: number,
  format: 'txt' | 'csv',
  mode: 'readable' | 'raw' = 'readable',
): Promise<{ blob: Blob; filename: string }> => {
  const response = await fetch(
    `${API_BASE}/processing/${meetingId}/transcript/export?format=${encodeURIComponent(format)}&mode=${encodeURIComponent(mode)}`,
    {
      method: 'GET',
      headers: withTraceHeaders(),
    },
  )

  if (!response.ok) {
    const text = await response.text()
    const traceId = response.headers.get('x-trace-id') ?? response.headers.get('x-request-id') ?? undefined
    let message = text || response.statusText

    try {
      const parsed = JSON.parse(text) as { detail?: string; message?: string }
      message = parsed.detail || parsed.message || message
    } catch {
      // Use raw text when response is not JSON.
    }

    throw new ApiError(message, response.status, traceId)
  }

  const blob = await response.blob()
  const filename = parseFilenameFromContentDisposition(response.headers.get('content-disposition'))
    || `meeting-${meetingId}-transcript-${mode}.${format}`
  return { blob, filename }
}

export const getProcessingStatus = async (meetingId: number): Promise<{
  meeting_id: number
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | string
  error?: string | null
  updated_at?: string
}> => {
  const raw = await fetchJson<{
    meeting_id?: number
    meetingId?: number
    status?: string
    error?: string | null
    updated_at?: string
    updatedAt?: string
  }>(`${API_BASE}/processing/status/${meetingId}`)

  return {
    meeting_id: raw.meeting_id ?? raw.meetingId ?? meetingId,
    status: raw.status ?? 'UNKNOWN',
    error: raw.error,
    updated_at: raw.updated_at ?? raw.updatedAt,
  }
}

export const createMeeting = async (): Promise<CreateMeetingResponse> => {
  return fetchJson<CreateMeetingResponse>(`${MEETING_API_BASE}/api/v1/meetings`, {
    method: 'POST',
  })
}

export const createRealtimeMeeting = async (
  title = 'Live recording session',
  language?: string,
  domainMode?: string,
): Promise<{
  id: number
  audioPath: string
  title: string
  duplicate?: boolean
  reused?: boolean
  existingMeetingId?: number | null
  status?: string
  createdAt?: string
  originalFileName?: string | null
  ownerUserId?: number | null
  language?: string | null
  fileSize?: number | null
  source?: string
}> => {
  const body: Record<string, string> = { title }
  if (language?.trim()) {
    body.language = language.trim()
  }
  if (domainMode?.trim()) {
    body.domainMode = domainMode.trim()
  }

  return fetchJson(`${MEETING_API_BASE}/meetings/realtime`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const processMeeting = async (meetingId: string) => {
  const body: CreateJobRequest = { meeting_id: meetingId }
  return fetchJson(`${PROCESSING_API_BASE}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const getMeeting = async (meetingId: string): Promise<GetMeetingResponse> => {
  return fetchJson<GetMeetingResponse>(`${MEETING_API_BASE}/api/v1/meetings/${meetingId}`)
}

export const listMeetings = async (): Promise<Meeting[]> => {
  return fetchJson<Meeting[]>(`${MEETING_API_BASE}/meetings`)
}

export const getMeetingDetail = async (
  meetingId: number,
  options: ApiRequestOptions = {},
): Promise<Meeting> => {
  return fetchJson<Meeting>(`${MEETING_API_BASE}/meetings/${meetingId}`, { signal: options.signal })
}

export const fetchMeetingAudioBlob = async (
  meetingId: number,
): Promise<{ blob: Blob; filename: string }> => {
  const response = await fetch(`${MEETING_API_BASE}/meetings/${meetingId}/audio`, {
    method: 'GET',
    headers: withTraceHeaders(),
  })

  if (!response.ok) {
    throw await parseApiErrorResponse(response)
  }

  const blob = await response.blob()
  const filename = parseFilenameFromContentDisposition(response.headers.get('content-disposition'))
    || `meeting-${meetingId}-audio`
  return { blob, filename }
}

export type ListMeetingsParams = {
  query?: string
  status?: string
  language?: string
  sort?: string
  page?: number
  pageSize?: number
}

export type MeetingListPage = {
  items: Meeting[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export const MEETING_HISTORY_PAGE_SIZE = 10

export const listMeetingsWithParams = async (
  params: ListMeetingsParams = {},
  options: ApiRequestOptions = {},
): Promise<Meeting[]> => {
  const query = new URLSearchParams()
  if (params.query?.trim()) {
    query.set('query', params.query.trim())
  }
  if (params.status?.trim()) {
    query.set('status', params.status.trim())
  }
  if (params.language?.trim()) {
    query.set('language', params.language.trim())
  }
  if (params.sort?.trim()) {
    query.set('sort', params.sort.trim())
  }
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return fetchJson<Meeting[]>(`${MEETING_API_BASE}/meetings${suffix}`, { signal: options.signal })
}

export const listMeetingsPage = async (
  params: ListMeetingsParams & { page: number; pageSize?: number },
  options: ApiRequestOptions = {},
): Promise<MeetingListPage> => {
  const query = new URLSearchParams()
  if (params.query?.trim()) {
    query.set('query', params.query.trim())
  }
  if (params.status?.trim()) {
    query.set('status', params.status.trim())
  }
  if (params.language?.trim()) {
    query.set('language', params.language.trim())
  }
  if (params.sort?.trim()) {
    query.set('sort', params.sort.trim())
  }
  query.set('page', String(params.page))
  query.set('pageSize', String(params.pageSize ?? MEETING_HISTORY_PAGE_SIZE))
  const response = await fetchJson<MeetingListPage>(`${MEETING_API_BASE}/meetings?${query.toString()}`, {
    signal: options.signal,
  })
  return {
    items: response.items ?? [],
    total: response.total ?? 0,
    page: response.page ?? params.page,
    pageSize: response.pageSize ?? (params.pageSize ?? MEETING_HISTORY_PAGE_SIZE),
    totalPages: response.totalPages ?? 0,
  }
}

export const renameMeeting = async (meetingId: number, title: string): Promise<Meeting> => {
  return fetchJson<Meeting>(`${MEETING_API_BASE}/meetings/${meetingId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

export const deleteMeeting = async (meetingId: number): Promise<{ id: number; deleted: boolean }> => {
  return fetchJson<{ id: number; deleted: boolean }>(`${MEETING_API_BASE}/meetings/${meetingId}`, {
    method: 'DELETE',
  })
}

/**
 * Returns standard auth + trace headers for API calls.
 * Use this when calling APIs outside of fetchJson (e.g. WebSocket, direct fetch).
 */
export const getAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {}
  const accessToken = getAccessToken()
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }
  headers['x-trace-id'] = createTraceId()
  headers['x-request-id'] = headers['x-trace-id']
  return headers
}

/**
 * Upload file to meeting-api which creates a Meeting record AND saves the file.
 * Returns the persisted Meeting entity with id and audioPath.
 */
export const uploadToMeetingApi = async (
  title: string,
  file: File,
  language?: string,
): Promise<{
  id: number
  audioPath: string
  title: string
  duplicate?: boolean
  reused?: boolean
  existingMeetingId?: number | null
  status?: string
  createdAt?: string
  originalFileName?: string | null
  ownerUserId?: number | null
  language?: string | null
  fileSize?: number | null
}> => {
  const body = new FormData()
  body.append('title', title)
  body.append('file', file)
  if (language) {
    body.append('language', language.trim())
  }
  // Do NOT set Content-Type manually — browser auto-adds multipart boundary
  return fetchJson<{
    id: number
    audioPath: string
    title: string
    duplicate?: boolean
    reused?: boolean
    existingMeetingId?: number | null
    status?: string
    createdAt?: string
    originalFileName?: string | null
    ownerUserId?: number | null
    language?: string | null
    fileSize?: number | null
  }>(
    `${MEETING_API_BASE}/meetings/upload`,
    { method: 'POST', body }
  )
}

/**
 * Start processing for an existing meeting by its ID.
 */
export const startProcessingByPath = async (
  meetingId: number,
  language?: string,
  domainMode?: string,
) => {
  const params = new URLSearchParams()
  if (language?.trim()) {
    params.set('language', language.trim())
  }
  if (domainMode?.trim()) {
    params.set('domain_mode', domainMode.trim())
  }
  const query = params.toString() ? `?${params.toString()}` : ''
  return fetchJson<Record<string, unknown>>(
    `${PROCESSING_API_BASE}/processing/start/${meetingId}${query}`,
    { method: 'POST' }
  )
}

export const updateUserPreferences = async (domainMode: string): Promise<{ domainMode?: string }> => {
  return fetchJson<{ domainMode?: string }>(`${USER_API_BASE}/api/users/me/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domainMode }),
  })
}

export type UserProfile = {
  userId: number
  username: string
  email: string
  domainMode?: string | null
}

export const getUserProfile = async (): Promise<UserProfile> => {
  const payload = await fetchJson<Record<string, unknown>>(`${USER_API_BASE}/api/users/me`)
  return {
    userId: Number(payload.userId ?? payload.user_id ?? 0),
    username: String(payload.username ?? ''),
    email: String(payload.email ?? ''),
    domainMode: firstString(payload.domainMode, payload.domain_mode) ?? null,
  }
}

/**
 * Poll with automatic retry on transient errors (network, 5xx).
 * Throws immediately on 4xx (client errors like 401, 404) — no retry.
 */
export const pollWithRetry = async (
  meetingId: number,
  retries = 3,
  delay = 2000
): Promise<ReturnType<typeof getProcessingStatus>> => {
  for (let i = 0; i < retries; i++) {
    try {
      return await getProcessingStatus(meetingId)
    } catch (error) {
      // Don't retry 4xx client errors
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        throw error
      }
      if (i === retries - 1) throw error
      if (isApiDebugLoggingEnabled()) {
        console.warn(`Polling failed, retrying in ${delay}ms...`, error)
      }
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Unreachable')
}
