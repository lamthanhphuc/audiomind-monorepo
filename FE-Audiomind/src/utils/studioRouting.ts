import type { DashboardScene } from '../components/dashboard/DashboardLayout'
import type { MeetingResultScope } from './meetingResultScope'
import { isLegacyResultScope, scopeToSearchParams } from './meetingResultScope'

export type ParsedStudioRoute = {
  scene: DashboardScene
  meetingId: number | null
  subjectId?: number | null
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
  subjects: '/studio/subjects',
  subjectDetail: '/studio/subjects/:subjectId',
  unclassified: '/studio/unclassified',
}

const SCENE_BY_PATH = Object.fromEntries(
  Object.entries(STUDIO_SCENE_PATHS)
    .filter(([scene]) => scene !== 'subjectDetail')
    .map(([scene, path]) => [path, scene]),
) as Record<string, DashboardScene>

const parseSubjectIdFromPath = (pathname: string): number | null => {
  const match = /^\/studio\/subjects\/(\d+)$/.exec(pathname)
  if (!match) return null
  const subjectId = Number(match[1])
  return Number.isFinite(subjectId) && subjectId > 0 ? subjectId : null
}

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
    return { scene: 'upload', meetingId: null, subjectId: null, resultScope: null }
  }

  const subjectIdFromPath = parseSubjectIdFromPath(path)
  if (subjectIdFromPath != null) {
    return { scene: 'subjectDetail', meetingId: null, subjectId: subjectIdFromPath, resultScope: null }
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
    return { scene, meetingId, subjectId: null, resultScope }
  }

  return { scene, meetingId: null, subjectId: null, resultScope: null }
}

export const buildStudioPath = (
  scene: DashboardScene,
  options?: {
    meetingId?: number | null
    subjectId?: number | null
    resultScope?: MeetingResultScope | null
  },
): string => {
  if (scene === 'subjectDetail' && options?.subjectId != null && options.subjectId > 0) {
    return `/studio/subjects/${options.subjectId}`
  }
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
    subjectId?: number | null
    resultScope?: MeetingResultScope | null
    replace?: boolean
  },
): void => {
  if (typeof window === 'undefined') return
  const path = buildStudioPath(scene, {
    meetingId: options?.meetingId,
    subjectId: options?.subjectId,
    resultScope: options?.resultScope,
  })
  const method = options?.replace ? 'replaceState' : 'pushState'
  window.history[method]({}, '', path)
}

export const resolveStudioRedirectAfter = (redirectAfter: string | null): ParsedStudioRoute => {
  if (!redirectAfter || !redirectAfter.startsWith('/') || redirectAfter.startsWith('//')) {
    return { scene: 'integrations', meetingId: null, subjectId: null, resultScope: null }
  }
  try {
    const url = new URL(redirectAfter, window.location.origin)
    return parseStudioRouteFromLocation(url) ?? { scene: 'integrations', meetingId: null, subjectId: null, resultScope: null }
  } catch {
    return { scene: 'integrations', meetingId: null, subjectId: null, resultScope: null }
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
    setSelectedSubjectId?: (id: number | null) => void
  },
): void => {
  handlers.setFeatureScene(route.scene)
  if (route.scene === 'analysis') {
    handlers.setHistoryAnalysisMeetingId(route.meetingId)
    handlers.setHistoryAnalysisScope?.(route.resultScope ?? null)
  } else if (route.scene === 'mindmap') {
    handlers.setMindmapSelectedMeetingId(route.meetingId)
    handlers.setMindmapSelectedScope?.(route.resultScope ?? null)
  } else if (route.scene === 'subjectDetail') {
    handlers.setSelectedSubjectId?.(route.subjectId ?? null)
  }
}
