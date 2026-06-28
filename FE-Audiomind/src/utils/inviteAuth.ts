/**
 * Share-invite URL contract:
 * - Pre-auth guest CTA: {origin}/register?openMeeting={id}
 * - Existing user deep link: {origin}/?openMeeting={id} (see backend meetingUrl)
 * - Post-auth OAuth redirect_after: /studio/analysis?meetingId={id}
 * - No invite: / or /studio/upload (default upload scene)
 *
 * Params: openMeeting = pre-auth marketing link; meetingId = studio route after login.
 */
import type { DashboardScene } from '../components/dashboard/DashboardLayout'
import { applyParsedStudioRoute, buildStudioPath } from './studioRouting'

export type PostAuthDestination =
  | { scene: 'analysis'; meetingId: number }
  | { scene: 'upload'; meetingId: null }

const OPEN_MEETING_PARAM = 'openMeeting'

export function readOpenMeetingId(search?: string): number | null {
  const raw = new URLSearchParams(search ?? (typeof window !== 'undefined' ? window.location.search : ''))
    .get(OPEN_MEETING_PARAM)
  if (!raw) {
    return null
  }
  const meetingId = Number(raw)
  return Number.isFinite(meetingId) && meetingId > 0 ? meetingId : null
}

export function buildInviteRegisterUrl(origin: string, meetingId: number): string {
  const base = origin.trim().replace(/\/$/, '')
  return `${base}/register?${OPEN_MEETING_PARAM}=${meetingId}`
}

export function buildExistingUserMeetingUrl(origin: string, meetingId: number): string {
  const base = origin.trim().replace(/\/$/, '')
  return `${base}/?${OPEN_MEETING_PARAM}=${meetingId}`
}

export function buildInviteGoogleRedirectAfter(search?: string): string {
  const meetingId = readOpenMeetingId(search)
  if (meetingId != null) {
    return buildStudioPath('analysis', { meetingId })
  }
  return '/'
}

export function appendOpenMeetingQuery(path: string, search?: string): string {
  const meetingId = readOpenMeetingId(search)
  if (meetingId == null) {
    return path
  }
  return `${path}?${OPEN_MEETING_PARAM}=${meetingId}`
}

export function resolvePostAuthDestination(search?: string): PostAuthDestination {
  const meetingId = readOpenMeetingId(search)
  if (meetingId != null) {
    return { scene: 'analysis', meetingId }
  }
  return { scene: 'upload', meetingId: null }
}

export function resolveDestinationFromRedirectAfter(redirectAfter: string | null): PostAuthDestination {
  if (!redirectAfter?.startsWith('/') || redirectAfter.startsWith('//')) {
    return { scene: 'upload', meetingId: null }
  }
  try {
    const url = new URL(redirectAfter, 'http://local.invalid')
    const fromOpenMeeting = readOpenMeetingId(url.search)
    if (fromOpenMeeting != null) {
      return { scene: 'analysis', meetingId: fromOpenMeeting }
    }
    const meetingId = Number(url.searchParams.get('meetingId'))
    if (url.pathname === '/studio/analysis' && Number.isFinite(meetingId) && meetingId > 0) {
      return { scene: 'analysis', meetingId }
    }
  } catch {
    // fall through to upload default
  }
  return { scene: 'upload', meetingId: null }
}

export function applyPostAuthDestination(
  destination: PostAuthDestination,
  handlers: {
    setFeatureScene: (scene: DashboardScene) => void
    setHistoryAnalysisMeetingId: (id: number | null) => void
    setMindmapSelectedMeetingId: (id: number | null) => void
    navigateFeatureScene?: (scene: DashboardScene, options?: { meetingId?: number | null; replace?: boolean }) => void
  },
): void {
  if (handlers.navigateFeatureScene) {
    if (destination.scene === 'analysis') {
      handlers.navigateFeatureScene('analysis', { meetingId: destination.meetingId, replace: true })
    } else {
      handlers.navigateFeatureScene('upload', { replace: true })
    }
    return
  }

  if (destination.scene === 'analysis') {
    applyParsedStudioRoute({ scene: 'analysis', meetingId: destination.meetingId }, handlers)
    if (typeof window !== 'undefined') {
      window.history.replaceState({}, '', buildStudioPath('analysis', { meetingId: destination.meetingId }))
    }
    return
  }

  applyParsedStudioRoute({ scene: 'upload', meetingId: null }, handlers)
}
