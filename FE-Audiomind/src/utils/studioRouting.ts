import type { DashboardScene } from '../components/dashboard/DashboardLayout'
import type { MeetingResultScope } from './meetingResultScope'
import { isLegacyResultScope, scopeToSearchParams } from './meetingResultScope'

export type ParsedStudioRoute = {
  scene: DashboardScene
  meetingId: number | null
  resultScope?: MeetingResultScope | null
}

export const STUDIO_SCENE_PATHS: Record<DashboardScene, string> = {
  upload: '/studio/upload',
  realtime: '/studio/realtime',
  analysis: '/studio/analysis',
  files: '/studio/history',
  mindmap: '/studio/mindmap',
  knowledge: '/studio/knowledge',
  insights: '/studio/insights',
  integrations: '/studio/integrations',
  billing: '/studio/billing',
}

const SCENE_BY_PATH = Object.fromEntries(
  Object.entries(STUDIO_SCENE_PATHS).map(([scene, path]) => [path, scene]),
) as Record<string, DashboardScene>

const parseMeetingId = (raw: string | null): number | null => {
  if (!raw) return null
  const meetingId = Number(raw)
  return Number.isFinite(meetingId) && meetingId > 0 ? meetingId : null
}

export const parseStudioRouteFromLocation = (
  loc: Pick<Location, 'pathname' | 'search'> = window.location,
): ParsedStudioRoute | null => {
  const path = loc.pathname
  const params = new URLSearchParams(loc.search)
  const meetingId = parseMeetingId(params.get('meetingId'))

  if (path === '/' || path === STUDIO_SCENE_PATHS.upload) {
    return { scene: 'upload', meetingId: null, resultScope: null }
  }

  const scene = SCENE_BY_PATH[path]
  if (!scene) {
    return null
  }

  if (scene === 'analysis' || scene === 'mindmap') {
    let resultScope: MeetingResultScope | null = null
    if (meetingId != null) {
      const recordingSessionId = parseMeetingId(params.get('recordingSessionId'))
      const attemptId = parseMeetingId(params.get('attemptId'))
      if (recordingSessionId != null && attemptId != null) {
        resultScope = {
          scopeKind: 'v2',
          meetingId,
          recordingSessionId,
          attemptId,
        }
      }
    }
    return { scene, meetingId, resultScope }
  }

  return { scene, meetingId: null, resultScope: null }
}

export const buildStudioPath = (
  scene: DashboardScene,
  options?: {
    meetingId?: number | null
    resultScope?: MeetingResultScope | null
  },
): string => {
  const base = STUDIO_SCENE_PATHS[scene]
  const meetingId = options?.meetingId
  if (meetingId && (scene === 'analysis' || scene === 'mindmap')) {
    const scope = options?.resultScope
    if (scope && scope.meetingId === meetingId && !isLegacyResultScope(scope)) {
      return `${base}?${scopeToSearchParams(scope).toString()}`
    }
    return `${base}?meetingId=${meetingId}`
  }
  return base
}

export const pushStudioRoute = (
  scene: DashboardScene,
  options?: {
    meetingId?: number | null
    resultScope?: MeetingResultScope | null
    replace?: boolean
  },
): void => {
  if (typeof window === 'undefined') return
  const path = buildStudioPath(scene, {
    meetingId: options?.meetingId,
    resultScope: options?.resultScope,
  })
  const method = options?.replace ? 'replaceState' : 'pushState'
  window.history[method]({}, '', path)
}

export const resolveStudioRedirectAfter = (redirectAfter: string | null): ParsedStudioRoute => {
  if (!redirectAfter || !redirectAfter.startsWith('/') || redirectAfter.startsWith('//')) {
    return { scene: 'integrations', meetingId: null, resultScope: null }
  }
  try {
    const url = new URL(redirectAfter, window.location.origin)
    return parseStudioRouteFromLocation(url) ?? { scene: 'integrations', meetingId: null, resultScope: null }
  } catch {
    return { scene: 'integrations', meetingId: null, resultScope: null }
  }
}

export const applyParsedStudioRoute = (
  route: ParsedStudioRoute,
  handlers: {
    setFeatureScene: (scene: DashboardScene) => void
    setHistoryAnalysisMeetingId: (id: number | null) => void
    setHistoryAnalysisScope?: (scope: MeetingResultScope | null) => void
    setMindmapSelectedMeetingId: (id: number | null) => void
    setMindmapSelectedScope?: (scope: MeetingResultScope | null) => void
  },
): void => {
  handlers.setFeatureScene(route.scene)
  if (route.scene === 'analysis') {
    handlers.setHistoryAnalysisMeetingId(route.meetingId)
    handlers.setHistoryAnalysisScope?.(route.resultScope ?? null)
  } else if (route.scene === 'mindmap') {
    handlers.setMindmapSelectedMeetingId(route.meetingId)
    handlers.setMindmapSelectedScope?.(route.resultScope ?? null)
  }
}
