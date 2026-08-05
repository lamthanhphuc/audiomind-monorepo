import { useEffect } from 'react'
import type { DashboardScene } from '../components/dashboard/DashboardLayout'
import { subscribeOAuthComplete } from '../utils/oauthCallbackHandoff'
import {
  applyParsedStudioRoute,
  parseStudioRouteFromLocation,
  pushStudioRoute,
  type ParsedStudioRoute,
} from '../utils/studioRouting'
import type { MeetingResultScope } from '../utils/meetingResultScope'
import type { SubjectDetailTab } from '../utils/subjectTabs'

type StudioRouteStateSetters = {
  setFeatureScene: (scene: DashboardScene) => void
  setHistoryAnalysisMeetingId: (id: number | null) => void
  setHistoryAnalysisScope: (scope: MeetingResultScope | null) => void
  setMindmapSelectedMeetingId: (id: number | null) => void
  setMindmapSelectedScope: (scope: MeetingResultScope | null) => void
  setSelectedSubjectId?: (id: number | null) => void
  setSelectedSubjectTab?: (tab: SubjectDetailTab | null) => void
}

type OAuthNoticeHandlers = {
  setGoogleIntegrationNotice: (message: string | null) => void
  bumpOauthRefreshTick: () => void
}

export const useStudioRouteSync = (
  routeSetters: StudioRouteStateSetters,
  noticeHandlers: OAuthNoticeHandlers,
) => {
  useEffect(() => {
    const syncStudioRouteFromBrowser = () => {
      const parsed = parseStudioRouteFromLocation()
      if (!parsed) return
      applyParsedStudioRoute(parsed, routeSetters)
    }
    window.addEventListener('popstate', syncStudioRouteFromBrowser)
    return () => window.removeEventListener('popstate', syncStudioRouteFromBrowser)
  }, [routeSetters])

  useEffect(() => {
    return subscribeOAuthComplete((event) => {
      if (event.route) {
        applyParsedStudioRoute(event.route as ParsedStudioRoute, routeSetters)
        pushStudioRoute(event.route.scene, {
          meetingId: event.route.meetingId,
          subjectId: event.route.subjectId,
          subjectTab: event.route.subjectTab,
          resultScope: event.route.resultScope ?? null,
          evidenceSegmentId: event.route.evidenceSegmentId,
          replace: true,
        })
      }
      if (event.provider === 'google') {
        noticeHandlers.setGoogleIntegrationNotice(event.message)
      }
      noticeHandlers.bumpOauthRefreshTick()
    })
  }, [noticeHandlers, routeSetters])
}
