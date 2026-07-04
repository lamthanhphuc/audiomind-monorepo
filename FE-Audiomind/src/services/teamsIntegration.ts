import { getAccessToken } from './auth'
import { USER_API_BASE } from './config'

export type TeamsStatus = {
  linked: boolean
  teamsEmail: string | null
  grantedScopes: string[]
}

export type TeamsRecordingFile = {
  id?: string
  fileType?: string
  fileSize?: number
  recordingStart?: string
  status?: string
}

export type TeamsRecordingMeeting = {
  uuid: string
  meetingId?: string
  recordingId?: string
  topic?: string
  startTime?: string
  duration?: number
  recordingFiles: TeamsRecordingFile[]
}

export type TeamsImportResult = {
  meetingId: number
  duplicate: boolean
  reused: boolean
  processingStarted: boolean
  title: string
  status?: string
}

export class TeamsIntegrationError extends Error {
  status: number
  errorCode?: string

  constructor(message: string, status: number, errorCode?: string) {
    super(message)
    this.name = 'TeamsIntegrationError'
    this.status = status
    this.errorCode = errorCode
  }
}

const authenticatedFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const token = getAccessToken()
  if (!token) throw new TeamsIntegrationError('Phiên đăng nhập đã hết hạn', 401)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: string; message?: string } | null
    throw new TeamsIntegrationError(
      payload?.message || `Teams integration request failed: ${response.status}`,
      response.status,
      payload?.code,
    )
  }
  return response
}

export const getTeamsStatus = async (): Promise<TeamsStatus> => {
  const response = await authenticatedFetch(`${USER_API_BASE}/users/me/teams/status`)
  return response.json() as Promise<TeamsStatus>
}

export const startTeamsLink = async (redirectAfter = '/studio/integrations'): Promise<string> => {
  const response = await authenticatedFetch(`${USER_API_BASE}/auth/teams/link/start`, {
    method: 'POST',
    body: JSON.stringify({ redirectAfter }),
  })
  const payload = await response.json() as { authorizationUri?: string }
  if (!payload.authorizationUri) {
    throw new TeamsIntegrationError('Không nhận được Teams authorization URI', 502)
  }
  return payload.authorizationUri
}

export const revokeTeamsGrant = async (): Promise<void> => {
  await authenticatedFetch(`${USER_API_BASE}/users/me/teams/grant`, { method: 'DELETE' })
}

export const listTeamsRecordings = async (
  from?: string,
  to?: string,
): Promise<{ from: string; to: string; meetings: TeamsRecordingMeeting[] }> => {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await authenticatedFetch(`${USER_API_BASE}/users/me/teams/recordings${suffix}`)
  const payload = await response.json() as {
    from?: string
    to?: string
    meetings?: TeamsRecordingMeeting[]
  }
  return {
    from: payload.from || '',
    to: payload.to || '',
    meetings: Array.isArray(payload.meetings) ? payload.meetings : [],
  }
}

export const importTeamsRecording = async (
  meetingUuid: string,
  options?: { recordingFileId?: string; title?: string; language?: string },
): Promise<TeamsImportResult> => {
  const response = await authenticatedFetch(`${USER_API_BASE}/users/me/teams/recordings/import`, {
    method: 'POST',
    body: JSON.stringify({
      meetingUuid,
      recordingFileId: options?.recordingFileId,
      title: options?.title,
      language: options?.language,
    }),
  })
  return response.json() as Promise<TeamsImportResult>
}
