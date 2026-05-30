import type { paths as MeetingPaths } from '../../../packages/api-clients/meeting'
import type { paths as ProcessingPaths } from '../../../packages/api-clients/processing'
import { normalizeAnalysisResponse, type AiAnalysis, type Meeting, type TranscriptResponse } from '../types'
import { getAccessToken } from './auth'
import { API_BASE, MEETING_API_BASE, PROCESSING_API_BASE } from './config'

type CreateMeetingResponse =
  MeetingPaths['/api/v1/meetings']['post']['responses'][200]['content']['application/json']

type GetMeetingResponse =
  MeetingPaths['/api/v1/meetings/{id}']['get']['responses'][200]['content']['application/json']

type CreateJobRequest =
  ProcessingPaths['/api/v1/jobs']['post']['requestBody']['content']['application/json']

export class ApiError extends Error {
  status: number

  traceId?: string

  constructor(message: string, status: number, traceId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.traceId = traceId
  }
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

    try {
      const parsed = JSON.parse(text) as { detail?: string; message?: string }
      message = parsed.detail || parsed.message || message
    } catch {
      // Use raw text when response is not JSON.
    }

    console.error('API request failed', {
      url: String(input),
      status: response.status,
      statusText: response.statusText,
      responseBody: text,
      traceId,
    })
    throw new ApiError(message, response.status, traceId)
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

export const getTranscript = async (meetingId: number): Promise<TranscriptResponse> => {
  const response = await fetchJson<TranscriptResponse | { data?: TranscriptResponse }>(
    `${API_BASE}/processing/transcript/${meetingId}`
  )

  if ('data' in response && response.data) {
    return response.data
  }
  return response as TranscriptResponse
}

export const getAnalysis = async (meetingId: number): Promise<AiAnalysis> => {
  const response = await fetchJson<AiAnalysis | { data?: AiAnalysis } & { status?: string }>(
    `${API_BASE}/processing/${meetingId}/analysis`
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

export const getSavedAnalysis = async (meetingId: number): Promise<AiAnalysis> => {
  const response = await fetchJson<AiAnalysis | { data?: AiAnalysis } & { status?: string }>(
    `${API_BASE}/processing/${meetingId}/analysis/saved`
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

export const getMeetingDetail = async (meetingId: number): Promise<Meeting> => {
  return fetchJson<Meeting>(`${MEETING_API_BASE}/meetings/${meetingId}`)
}

export type ListMeetingsParams = {
  query?: string
  status?: string
  language?: string
  sort?: string
}

export const listMeetingsWithParams = async (params: ListMeetingsParams = {}): Promise<Meeting[]> => {
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
  return fetchJson<Meeting[]>(`${MEETING_API_BASE}/meetings${suffix}`)
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
export const startProcessingByPath = async (meetingId: number, language?: string) => {
  const query = language && language.trim()
    ? `?language=${encodeURIComponent(language.trim())}`
    : ''
  return fetchJson<Record<string, unknown>>(
    `${PROCESSING_API_BASE}/processing/start/${meetingId}${query}`,
    { method: 'POST' }
  )
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
      console.warn(`Polling failed, retrying in ${delay}ms...`, error)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Unreachable')
}
