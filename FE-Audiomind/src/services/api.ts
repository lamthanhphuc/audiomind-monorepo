import type { AiAnalysis, TranscriptResponse } from '../types'
import { API_BASE } from './config'

const fetchJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const text = await response.text()
    console.error('API request failed', {
      url: String(input),
      status: response.status,
      statusText: response.statusText,
      responseBody: text,
    })
    throw new Error(text || response.statusText)
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
  return fetchJson<Record<string, unknown>>(`${API_BASE}/api/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export const uploadAudio = async (file: File): Promise<{ audio_path: string; original_filename: string }> => {
  const body = new FormData()
  body.append('file', file)

  return fetchJson<{ audio_path: string; original_filename: string }>(`${API_BASE}/api/upload-audio`, {
    method: 'POST',
    body,
  })
}

export const getTranscript = async (meetingId: number): Promise<TranscriptResponse> => {
  return fetchJson<TranscriptResponse>(
    `${API_BASE}/api/meeting/${meetingId}/transcript`
  )
}

export const getAnalysis = async (meetingId: number): Promise<AiAnalysis> => {
  return fetchJson<AiAnalysis>(
    `${API_BASE}/api/meeting/${meetingId}/analysis`
  )
}
