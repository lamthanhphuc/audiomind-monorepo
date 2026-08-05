import type { DashboardScene } from '../components/dashboard/DashboardLayout'
import type { MeetingResultScope } from './meetingResultScope'
import { isLegacyResultScope, scopeToSearchParams } from './meetingResultScope'
import {
  DEFAULT_SUBJECT_TAB,
  parseSubjectDetailTab,
  type SubjectDetailTab,
} from './subjectTabs'
import { readEvidenceSegmentId } from './subjectEvidence'

export type ParsedStudioRoute = {
  scene: DashboardScene
  meetingId: number | null
  subjectId?: number | null
  subjectTab?: SubjectDetailTab | null
  resultScope?: MeetingResultScope | null
  evidenceSegmentId?: string | null
}

export const STUDIO_SCENE_PATHS: Record<DashboardScene, string> = {
  upload: '/studio/upload',
  realtime: '/studio/realtime',
  analysis: '/studio/analysis',
  files: '/studio/history',
  mindmap: '/studio/mindmap',
  knowledge: '/studio/knowledge',
  integrations: '/studio/integrations',
  billing: '/studio/billing',
  subjects: '/studio/subjects',
  subjectDetail: '/studio/subjects/:subjectId',
  unclassified: '/studio/unclassified',
  profile: '/studio/profile',
  settings: '/studio/settings',
  admin: '/studio/admin',
  notifications: '/studio/notifications',
  usage: '/studio/usage',
  audit: '/studio/audit',
}

const SCENE_BY_PATH = Object.fromEntries(
  Object.entries(STUDIO_SCENE_PATHS)
    .filter(([scene]) => scene !== 'subjectDetail')
    .map(([scene, path]) => [path, scene]),
) as Record<string, DashboardScene>

const parseSubjectRouteFromPath = (
  pathname: string,
): { subjectId: number; subjectTab: SubjectDetailTab } | null => {
  const match = /^\/studio\/subjects\/(\d+)(?:\/([a-z0-9-]+))?$/.exec(pathname)
  if (!match) return null
  const subjectId = Number(match[1])
  if (!Number.isFinite(subjectId) || subjectId <= 0) return null
  const tabRaw = match[2]
  if (!tabRaw) {
    return { subjectId, subjectTab: DEFAULT_SUBJECT_TAB }
  }
  // Unknown tab segments are not subject detail routes (avoid swallowing future paths).
  const tab = parseSubjectDetailTab(tabRaw)
  if (tab === DEFAULT_SUBJECT_TAB && tabRaw !== 'meetings') {
    return null
  }
  return { subjectId, subjectTab: tab }
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
    return {
      scene: 'upload',
      meetingId: null,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: null,
    }
  }

  const subjectRoute = parseSubjectRouteFromPath(path)
  if (subjectRoute != null) {
    return {
      scene: 'subjectDetail',
      meetingId: null,
      subjectId: subjectRoute.subjectId,
      subjectTab: subjectRoute.subjectTab,
      resultScope: null,
      evidenceSegmentId: null,
    }
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
    return {
      scene,
      meetingId,
      subjectId: null,
      subjectTab: null,
      resultScope,
      evidenceSegmentId: scene === 'analysis' ? readEvidenceSegmentId(loc) : null,
    }
  }

  return {
    scene,
    meetingId: null,
    subjectId: null,
    subjectTab: null,
    resultScope: null,
    evidenceSegmentId: null,
  }
}

export const buildStudioPath = (
  scene: DashboardScene,
  options?: {
    meetingId?: number | null
    subjectId?: number | null
    subjectTab?: SubjectDetailTab | null
    resultScope?: MeetingResultScope | null
    evidenceSegmentId?: string | null
  },
): string => {
  if (scene === 'subjectDetail' && options?.subjectId != null && options.subjectId > 0) {
    const tab = options.subjectTab && options.subjectTab !== DEFAULT_SUBJECT_TAB
      ? options.subjectTab
      : null
    return tab
      ? `/studio/subjects/${options.subjectId}/${tab}`
      : `/studio/subjects/${options.subjectId}`
  }
  const base = STUDIO_SCENE_PATHS[scene]
  const meetingId = options?.meetingId
  if (meetingId && (scene === 'analysis' || scene === 'mindmap')) {
    const params = new URLSearchParams()
    const scope = options?.resultScope
    if (scope && scope.meetingId === meetingId && !isLegacyResultScope(scope)) {
      for (const [key, value] of scopeToSearchParams(scope).entries()) {
        params.set(key, value)
      }
    } else {
      params.set('meetingId', String(meetingId))
    }
    if (scene === 'analysis' && options?.evidenceSegmentId?.trim()) {
      params.set('evidenceSegmentId', options.evidenceSegmentId.trim())
    }
    const query = params.toString()
    return query ? `${base}?${query}` : base
  }
  return base
}

export const pushStudioRoute = (
  scene: DashboardScene,
  options?: {
    meetingId?: number | null
    subjectId?: number | null
    subjectTab?: SubjectDetailTab | null
    resultScope?: MeetingResultScope | null
    evidenceSegmentId?: string | null
    replace?: boolean
  },
): void => {
  if (typeof window === 'undefined') return
  const path = buildStudioPath(scene, {
    meetingId: options?.meetingId,
    subjectId: options?.subjectId,
    subjectTab: options?.subjectTab,
    resultScope: options?.resultScope,
    evidenceSegmentId: options?.evidenceSegmentId,
  })
  const method = options?.replace ? 'replaceState' : 'pushState'
  const state =
    options?.evidenceSegmentId != null
      ? { evidenceSegmentId: options.evidenceSegmentId }
      : {}
  window.history[method](state, '', path)
}

export const resolveStudioRedirectAfter = (redirectAfter: string | null): ParsedStudioRoute => {
  if (!redirectAfter || !redirectAfter.startsWith('/') || redirectAfter.startsWith('//')) {
    return {
      scene: 'integrations',
      meetingId: null,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: null,
    }
  }
  try {
    const url = new URL(redirectAfter, window.location.origin)
    return (
      parseStudioRouteFromLocation(url) ?? {
        scene: 'integrations',
        meetingId: null,
        subjectId: null,
        subjectTab: null,
        resultScope: null,
        evidenceSegmentId: null,
      }
    )
  } catch {
    return {
      scene: 'integrations',
      meetingId: null,
      subjectId: null,
      subjectTab: null,
      resultScope: null,
      evidenceSegmentId: null,
    }
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
    setSelectedSubjectTab?: (tab: SubjectDetailTab | null) => void
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

  // Only the subjectDetail route carries a subjectId; every other route (including
  // browser back/forward navigation away from a subject) must clear the selection so
  // stale state doesn't leak into unrelated scenes.
  if (route.scene === 'subjectDetail') {
    handlers.setSelectedSubjectId?.(route.subjectId ?? null)
    handlers.setSelectedSubjectTab?.(route.subjectTab ?? DEFAULT_SUBJECT_TAB)
  } else {
    handlers.setSelectedSubjectId?.(null)
    handlers.setSelectedSubjectTab?.(null)
  }
}
