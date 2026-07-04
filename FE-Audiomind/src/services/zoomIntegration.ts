import { getAccessToken } from './auth'
import { USER_API_BASE } from './config'

export type ZoomStatus = {
  linked: boolean
  zoomEmail: string | null
  grantedScopes: string[]
}

export type ZoomRecordingFile = {
  id?: string
  fileType?: string
  fileSize?: number
  recordingStart?: string
  downloadUrl?: string
  status?: string
}

export type ZoomRecordingMeeting = {
  uuid: string
  id?: number
  topic?: string
  startTime?: string
  duration?: number
  recordingFiles: ZoomRecordingFile[]
}

export type ZoomImportResult = {
  meetingId: number
  duplicate: boolean
  reused: boolean
  processingStarted: boolean
  title: string
  status?: string
}

export class ZoomIntegrationError extends Error {
  status: number
  errorCode?: string

  constructor(message: string, status: number, errorCode?: string) {
    super(message)
    this.name = 'ZoomIntegrationError'
    this.status = status
    this.errorCode = errorCode
  }
}

const authenticatedFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const token = getAccessToken()
  if (!token) throw new ZoomIntegrationError('Phiên đăng nhập đã hết hạn', 401)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: string; message?: string } | null
    throw new ZoomIntegrationError(
      payload?.message || `Zoom integration request failed: ${response.status}`,
      response.status,
      payload?.code,
    )
  }
  return response
}

export const getZoomStatus = async (): Promise<ZoomStatus> => {
  const response = await authenticatedFetch(`${USER_API_BASE}/users/me/zoom/status`)
  return response.json() as Promise<ZoomStatus>
}

export const startZoomLink = async (redirectAfter = '/studio/integrations'): Promise<string> => {
  const response = await authenticatedFetch(`${USER_API_BASE}/auth/zoom/link/start`, {
    method: 'POST',
    body: JSON.stringify({ redirectAfter }),
  })
  const payload = await response.json() as { authorizationUri?: string }
  if (!payload.authorizationUri) {
    throw new ZoomIntegrationError('Không nhận được Zoom authorization URI', 502)
  }
  return payload.authorizationUri
}

export const revokeZoomGrant = async (): Promise<void> => {
  await authenticatedFetch(`${USER_API_BASE}/users/me/zoom/grant`, { method: 'DELETE' })
}

export const listZoomRecordings = async (
  from?: string,
  to?: string,
): Promise<{ from: string; to: string; meetings: ZoomRecordingMeeting[] }> => {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  const response = await authenticatedFetch(`${USER_API_BASE}/users/me/zoom/recordings${suffix}`)
  const payload = await response.json() as {
    from?: string
    to?: string
    meetings?: ZoomRecordingMeeting[]
  }
  return {
    from: payload.from || '',
    to: payload.to || '',
    meetings: Array.isArray(payload.meetings) ? payload.meetings : [],
  }
}

export const importZoomRecording = async (
  meetingUuid: string,
  options?: { recordingFileId?: string; title?: string; language?: string },
): Promise<ZoomImportResult> => {
  const response = await authenticatedFetch(`${USER_API_BASE}/users/me/zoom/recordings/import`, {
    method: 'POST',
    body: JSON.stringify({
      meetingUuid,
      recordingFileId: options?.recordingFileId,
      title: options?.title,
      language: options?.language,
    }),
  })
  const payload = await response.json() as ZoomImportResult
  return payload
}
