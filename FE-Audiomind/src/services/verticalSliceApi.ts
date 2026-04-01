import type { paths as MeetingPaths } from '../../../packages/api-clients/meeting'
import type { paths as ProcessingPaths } from '../../../packages/api-clients/processing'

const MEETING_API_BASE_URL = import.meta.env.VITE_MEETING_API_BASE_URL || 'http://localhost:8081'
const PROCESSING_API_BASE_URL = import.meta.env.VITE_PROCESSING_API_BASE_URL || 'http://localhost:8082'

type CreateMeetingResponse =
  MeetingPaths['/api/v1/meetings']['post']['responses'][200]['content']['application/json']

type GetMeetingResponse =
  MeetingPaths['/api/v1/meetings/{id}']['get']['responses'][200]['content']['application/json']

type CreateJobRequest =
  ProcessingPaths['/api/v1/jobs']['post']['requestBody']['content']['application/json']

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(await response.text())
  }
  return response.json() as Promise<T>
}

export const createMeeting = async (): Promise<CreateMeetingResponse> => {
  return fetchJson<CreateMeetingResponse>(`${MEETING_API_BASE_URL}/api/v1/meetings`, {
    method: 'POST',
  })
}

export const processMeeting = async (meetingId: string) => {
  const body: CreateJobRequest = { meeting_id: meetingId }
  return fetchJson(`${PROCESSING_API_BASE_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const getMeeting = async (meetingId: string): Promise<GetMeetingResponse> => {
  return fetchJson<GetMeetingResponse>(`${MEETING_API_BASE_URL}/api/v1/meetings/${meetingId}`)
}
