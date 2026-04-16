import type { AiAnalysis, TranscriptResponse } from '../types'
import type { paths as MeetingPaths } from '../../../packages/api-clients/meeting'
import type { paths as ProcessingPaths } from '../../../packages/api-clients/processing'
import { API_BASE, MEETING_API_BASE, PROCESSING_API_BASE } from './config'
import { getAccessToken } from './auth'

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
  const response = await fetchJson<AiAnalysis | { data?: AiAnalysis }>(
    `${API_BASE}/processing/${meetingId}/analysis`
  )

  if ('data' in response && response.data) {
    return response.data
  }
  return response as AiAnalysis
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
