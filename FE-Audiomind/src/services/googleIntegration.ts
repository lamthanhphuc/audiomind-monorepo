import { getAccessToken } from './auth'
import { MEETING_API_BASE, USER_API_BASE } from './config'

export const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
export const GOOGLE_GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'

export const FULL_GOOGLE_LINK_SCOPES = [
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
] as const

export type GoogleStatus = {
  linked: boolean
  googleEmail: string | null
  grantedScopes: string[]
  missingScopes: string[]
}

export type GoogleCalendarStatus = {
  meetingId: number
  creationStatus: string
  conferenceStatus: string
  googleCalendarEventId: string | null
  meetUri: string | null
  hangoutLink: string | null
  htmlLink: string | null
  errorCode: string | null
}

export type ScheduledMeeting = {
  id: number
  title: string
  status: 'scheduled' | string
  scheduledStartAt: string
  scheduledEndAt: string
  scheduledTimezone: string
}

export class GoogleIntegrationError extends Error {
  status: number
  errorCode?: string
  missingScopes: string[]

  constructor(message: string, status: number, errorCode?: string, missingScopes: string[] = []) {
    super(message)
    this.name = 'GoogleIntegrationError'
    this.status = status
    this.errorCode = errorCode
    this.missingScopes = missingScopes
  }
}

const authenticatedFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  const token = getAccessToken()
  if (!token) throw new GoogleIntegrationError('Phiên đăng nhập đã hết hạn', 401)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as {
      code?: string
      error?: string
      message?: string
      details?: { missingScopes?: string[] }
    } | null
    throw new GoogleIntegrationError(
      payload?.message || `Google integration request failed: ${response.status}`,
      response.status,
      payload?.error || payload?.code,
      payload?.details?.missingScopes || [],
    )
  }
  return response
}

export const getGoogleStatus = async (): Promise<GoogleStatus> => {
  const response = await authenticatedFetch(`${USER_API_BASE}/users/me/google/status`)
  return response.json() as Promise<GoogleStatus>
}

export const startGoogleLink = async (
  additionalScopes: string[] = [],
  redirectAfter = '/studio/integrations',
): Promise<string> => {
  const response = await authenticatedFetch(`${USER_API_BASE}/auth/google/link/start`, {
    method: 'POST',
    body: JSON.stringify({ additionalScopes, redirectAfter }),
  })
  const payload = await response.json() as { authorizationUrl: string }
  return payload.authorizationUrl
}

export const needsGoogleIntegrationGrant = (status: GoogleStatus): boolean => {
  return missingGoogleLinkScopes(status).length > 0
}

export const missingGoogleLinkScopes = (status: GoogleStatus): string[] => {
  return FULL_GOOGLE_LINK_SCOPES.filter((scope) => !status.grantedScopes.includes(scope))
}

export const hasGoogleCalendarScope = (status: GoogleStatus | null | undefined): boolean => {
  return Boolean(status?.grantedScopes.includes(GOOGLE_CALENDAR_EVENTS_SCOPE))
}

export const hasGoogleGmailSendScope = (status: GoogleStatus | null | undefined): boolean => {
  return Boolean(status?.grantedScopes.includes(GOOGLE_GMAIL_SEND_SCOPE))
}

/** Google login identity exists but Calendar grant is not stored yet. */
export const isGoogleLinkedWithoutCalendarGrant = (status: GoogleStatus | null | undefined): boolean => {
  return Boolean(status?.linked && !hasGoogleCalendarScope(status))
}

export type GoogleConnectionState = 'unlinked' | 'needs_calendar' | 'ready'

export const resolveGoogleConnectionState = (status: GoogleStatus | null | undefined): GoogleConnectionState => {
  if (!status?.linked) return 'unlinked'
  if (!hasGoogleCalendarScope(status)) return 'needs_calendar'
  return 'ready'
}

/** Same-tab redirect to Google link OAuth with Calendar + Gmail scopes (post-login step). */
export const redirectToFullGoogleLink = async (redirectAfter: string): Promise<void> => {
  const authorizationUrl = await startGoogleLink([...FULL_GOOGLE_LINK_SCOPES], redirectAfter)
  window.location.assign(authorizationUrl)
}

export const revokeGoogleGrant = async (): Promise<void> => {
  await authenticatedFetch(`${USER_API_BASE}/users/me/google/grant`, { method: 'DELETE' })
}

export const unlinkGoogleIdentity = async (): Promise<void> => {
  await authenticatedFetch(`${USER_API_BASE}/users/me/google/identity`, { method: 'DELETE' })
}

export const createGoogleCalendarEvent = async (
  meetingId: number,
  input: { startDateTime: string; endDateTime: string; timeZone: string; attendees: string[] },
): Promise<GoogleCalendarStatus> => {
  const response = await authenticatedFetch(
    `${MEETING_API_BASE}/meetings/${meetingId}/google/calendar-event`,
    { method: 'POST', body: JSON.stringify(input) },
  )
  return response.json() as Promise<GoogleCalendarStatus>
}

export const createScheduledMeeting = async (input: {
  title: string
  startDateTime: string
  endDateTime: string
  timeZone: string
  language?: string
}): Promise<ScheduledMeeting> => {
  const response = await authenticatedFetch(`${MEETING_API_BASE}/meetings/scheduled`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return response.json() as Promise<ScheduledMeeting>
}

export const getGoogleCalendarStatus = async (meetingId: number): Promise<GoogleCalendarStatus> => {
  const response = await authenticatedFetch(`${MEETING_API_BASE}/meetings/${meetingId}/google/status`)
  return response.json() as Promise<GoogleCalendarStatus>
}

const GOOGLE_POLL_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]

export const pollGoogleCalendarStatus = async (
  meetingId: number,
  options: {
    maxAttempts?: number
    onUpdate?: (status: GoogleCalendarStatus) => void
  } = {},
): Promise<GoogleCalendarStatus> => {
  const maxAttempts = options.maxAttempts ?? GOOGLE_POLL_DELAYS_MS.length
  let latest = await getGoogleCalendarStatus(meetingId)
  options.onUpdate?.(latest)

  for (let attempt = 0; attempt < maxAttempts && latest.creationStatus === 'creating'; attempt += 1) {
    const delay = GOOGLE_POLL_DELAYS_MS[Math.min(attempt, GOOGLE_POLL_DELAYS_MS.length - 1)]
    await new Promise((resolve) => window.setTimeout(resolve, delay))
    latest = await getGoogleCalendarStatus(meetingId)
    options.onUpdate?.(latest)
    if (latest.creationStatus === 'success' || latest.creationStatus === 'failed') {
      break
    }
  }

  return latest
}

export const listGoogleCalendars = async (): Promise<Record<string, unknown>> => {
  const response = await authenticatedFetch(`${MEETING_API_BASE}/meetings/google/calendars`)
  return response.json() as Promise<Record<string, unknown>>
}

export type StandaloneGoogleCalendarResult = {
  creationStatus: string
  conferenceStatus: string
  googleCalendarEventId: string | null
  meetUri: string | null
  hangoutLink: string | null
  htmlLink: string | null
  errorCode: string | null
}

export type GoogleCalendarMeetingListItem = {
  linkId: number
  meetingId: number | null
  title: string
  scheduledStartAt: string | null
  scheduledEndAt: string | null
  creationStatus: string
  meetUri: string | null
  htmlLink: string | null
}

export const listGoogleCalendarMeetings = async (): Promise<GoogleCalendarMeetingListItem[]> => {
  const response = await authenticatedFetch(`${MEETING_API_BASE}/meetings/google/calendar-links`)
  return response.json() as Promise<GoogleCalendarMeetingListItem[]>
}

export const createStandaloneGoogleCalendarEvent = async (input: {
  title: string
  startDateTime: string
  endDateTime: string
  timeZone: string
  attendees: string[]
}): Promise<StandaloneGoogleCalendarResult> => {
  const response = await authenticatedFetch(`${MEETING_API_BASE}/meetings/google/calendar-event`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return response.json() as Promise<StandaloneGoogleCalendarResult>
}

export const createQuickGoogleMeet = async (summary?: string): Promise<{
  eventId: string | null
  meetUri: string | null
  hangoutLink: string | null
  conferenceStatus: string
}> => {
  const response = await authenticatedFetch(`${MEETING_API_BASE}/meetings/google/meet`, {
    method: 'POST',
    body: JSON.stringify({ summary: summary ?? 'Audiomind meeting' }),
  })
  return response.json() as Promise<{
    eventId: string | null
    meetUri: string | null
    hangoutLink: string | null
    conferenceStatus: string
  }>
}
