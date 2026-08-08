import { useEffect, type MutableRefObject } from 'react'
import type { DashboardScene } from '../components/dashboard/DashboardLayout'
import {
  exchangeGoogleLoginTicket,
  getAccessToken,
  refreshAccessToken,
  setAccessToken,
} from '../services/auth'
import { applyPostAuthDestination, resolveDestinationFromRedirectAfter, resolvePostAuthDestination } from '../utils/inviteAuth'
import {
  INVITE_ACCESS_NOTICE,
  probeInvitedMeetingAccess,
} from '../utils/inviteAccess'
import { returnToOAuthOpener } from '../utils/oauthCallbackHandoff'
import type { MeetingResultScope } from '../utils/meetingResultScope'
import {
  applyParsedStudioRoute,
  buildStudioPath,
  parseStudioRouteFromLocation,
  resolveStudioRedirectAfter,
  type ParsedStudioRoute,
} from '../utils/studioRouting'
import {
  resolveGoogleLoginError,
} from './integrationCallbackMessages'

type GoogleCallbackState = 'idle' | 'processing' | 'linking'

type RouteSetters = {
  setFeatureScene: (scene: DashboardScene) => void
  setHistoryAnalysisMeetingId: (id: number | null) => void
  setHistoryAnalysisScope: (scope: MeetingResultScope | null) => void
  setMindmapSelectedMeetingId: (id: number | null) => void
  setMindmapSelectedScope: (scope: MeetingResultScope | null) => void
}

type InitialRedirectHandlingOptions = RouteSetters & {
  abortControllerRef: MutableRefObject<AbortController | null>
  liveAnalysisAbortControllerRef: MutableRefObject<AbortController | null>
  setIsAuthenticated: (value: boolean) => void
  setBillingActivationOrderCode: (orderCode: number | null) => void
  setBillingPaymentNotice: (message: string | null) => void
  setGoogleIntegrationNotice: (message: string | null) => void
  setOauthRefreshTick: (updater: (tick: number) => number) => void
  setSessionPlanSyncTick: (updater: (tick: number) => number) => void
  setGoogleCallbackState: (state: GoogleCallbackState) => void
  setAuthError: (message: string) => void
  setAuthNotice: (message: string) => void
  syncUserPreferencesFromServer: () => Promise<void>
}

const googleAlreadyLinkedMessage = 'Tài khoản Google này đã được liên kết với người dùng khác.'
const googleConnectionFailedMessage = 'Không thể kết nối Google. Vui lòng thử lại.'
const googleConnectedMessage = 'Đã kết nối Google và cập nhật quyền truy cập.'
const googleLoginInvalidMessage = 'Phiên đăng nhập Google không hợp lệ. Vui lòng thử lại.'
const billingSyncingMessage = 'Thanh toán PayOS thành công. Đang đồng bộ gói của bạn...'
const billingFallbackMessage = 'Thanh toán thành công. Gói đã cập nhật trên server - bấm "Đồng bộ JWT" nếu badge vẫn hiện Free.'
const billingCancelledMessage = 'Bạn đã hủy thanh toán. Bạn có thể thử lại bất cứ lúc nào.'

export const useInitialRedirectHandling = ({
  abortControllerRef,
  liveAnalysisAbortControllerRef,
  setIsAuthenticated,
  setFeatureScene,
  setHistoryAnalysisMeetingId,
  setHistoryAnalysisScope,
  setMindmapSelectedMeetingId,
  setMindmapSelectedScope,
  setBillingActivationOrderCode,
  setBillingPaymentNotice,
  setGoogleIntegrationNotice,
  setOauthRefreshTick,
  setSessionPlanSyncTick,
  setGoogleCallbackState,
  setAuthError,
  setAuthNotice,
  syncUserPreferencesFromServer,
}: InitialRedirectHandlingOptions) => {
  useEffect(() => {
    let active = true
    const cleanup = () => {
      active = false
      abortControllerRef.current?.abort()
      liveAnalysisAbortControllerRef.current?.abort()
    }
    const routeSetters: RouteSetters = {
      setFeatureScene,
      setHistoryAnalysisMeetingId,
      setHistoryAnalysisScope,
      setMindmapSelectedMeetingId,
      setMindmapSelectedScope,
    }
    const path = window.location.pathname

    if (path === '/billing/success') {
      const orderCode = Number(new URLSearchParams(window.location.search).get('orderCode') || 0)
      window.history.replaceState({}, '', buildStudioPath('billing'))
      setIsAuthenticated(Boolean(getAccessToken()))
      setFeatureScene('billing')
      setBillingActivationOrderCode(orderCode > 0 ? orderCode : null)
      if (orderCode <= 0) {
        setBillingPaymentNotice(billingSyncingMessage)
      }
      void refreshAccessToken().catch(() => {
        if (!active) return
        setBillingPaymentNotice(billingFallbackMessage)
      })
    } else if (path === '/billing/cancel') {
      window.history.replaceState({}, '', buildStudioPath('billing'))
      setIsAuthenticated(Boolean(getAccessToken()))
      setFeatureScene('billing')
      setBillingPaymentNotice(billingCancelledMessage)
    } else if (path === '/settings/integrations/google/success') {
      const redirectAfter = new URLSearchParams(window.location.search).get('redirectAfter')
      const route = resolveStudioRedirectAfter(redirectAfter)
      if (returnToOAuthOpener({
        provider: 'google',
        status: 'success',
        message: googleConnectedMessage,
        route,
        tone: 'success',
      })) {
        return cleanup
      }
      window.history.replaceState({}, '', buildStudioPath(route.scene, { meetingId: route.meetingId }))
      setIsAuthenticated(Boolean(getAccessToken()))
      applyParsedStudioRoute(route, routeSetters)
      setGoogleIntegrationNotice(googleConnectedMessage)
      setOauthRefreshTick((tick) => tick + 1)
    } else if (path === '/settings/integrations/google/error') {
      const errorCode = new URLSearchParams(window.location.search).get('errorCode')
      const message = errorCode === 'GOOGLE_ACCOUNT_ALREADY_LINKED'
        ? googleAlreadyLinkedMessage
        : googleConnectionFailedMessage
      const route: ParsedStudioRoute = { scene: 'integrations', meetingId: null }
      if (returnToOAuthOpener({
        provider: 'google',
        status: 'error',
        message,
        route,
        tone: 'error',
      })) {
        return cleanup
      }
      window.history.replaceState({}, '', buildStudioPath('integrations'))
      setIsAuthenticated(Boolean(getAccessToken()))
      setFeatureScene('integrations')
      setGoogleIntegrationNotice(message)
      setOauthRefreshTick((tick) => tick + 1)
    } else if (path === '/auth/google/success') {
      const ticket = new URLSearchParams(window.location.search).get('ticket')
      window.history.replaceState({}, '', '/auth/google/success')
      if (!ticket) {
        setGoogleCallbackState('idle')
        setAuthError(googleLoginInvalidMessage)
        window.history.replaceState({}, '', '/')
      } else {
        void exchangeGoogleLoginTicket(ticket)
          .then(async (response) => {
            if (!active) return
            setAccessToken(response.token, response.expiresInSeconds)
            setIsAuthenticated(true)
            void syncUserPreferencesFromServer()
            const redirectAfter = response.redirectAfter?.startsWith('/') ? response.redirectAfter : '/studio/upload'
            const destination = resolveDestinationFromRedirectAfter(redirectAfter)
            const studioPath = destination.scene === 'analysis'
              ? buildStudioPath('analysis', { meetingId: destination.meetingId })
              : buildStudioPath('upload')

            if (destination.scene === 'analysis') {
              const accessController = new AbortController()
              const accessTimeout = window.setTimeout(() => accessController.abort(), 3000)
              try {
                const access = await probeInvitedMeetingAccess(destination.meetingId, {
                  signal: accessController.signal,
                })
                if (access === 'forbidden') {
                  setAuthNotice(INVITE_ACCESS_NOTICE)
                }
              } finally {
                window.clearTimeout(accessTimeout)
              }
            }

            window.history.replaceState({}, '', studioPath)
            applyPostAuthDestination(destination, {
              setFeatureScene,
              setHistoryAnalysisMeetingId,
              setMindmapSelectedMeetingId,
            })
            setOauthRefreshTick((tick) => tick + 1)
            setGoogleCallbackState('idle')
          })
          .catch((error) => {
            if (!active) return
            setAuthError(error instanceof Error ? error.message : 'Đăng nhập Google thất bại')
            setGoogleCallbackState('idle')
            window.history.replaceState({}, '', '/')
          })
      }
    } else if (path === '/auth/google/error') {
      const errorCode = new URLSearchParams(window.location.search).get('errorCode')
      window.history.replaceState({}, '', '/')
      setAuthError(resolveGoogleLoginError(errorCode))
      setIsAuthenticated(false)
    } else {
      const hasToken = Boolean(getAccessToken())
      setIsAuthenticated(hasToken)
      if (hasToken) {
        void refreshAccessToken()
          .then(() => {
            if (active) setSessionPlanSyncTick((tick) => tick + 1)
          })
          .catch(() => {})
        void syncUserPreferencesFromServer()
      }
      const params = new URLSearchParams(window.location.search)
      if (hasToken) {
        const inviteDestination = resolvePostAuthDestination(params.toString())
        if (inviteDestination.scene === 'analysis') {
          applyPostAuthDestination(inviteDestination, {
            setFeatureScene,
            setHistoryAnalysisMeetingId,
            setMindmapSelectedMeetingId,
          })
        } else {
          const studioRoute = parseStudioRouteFromLocation()
          if (studioRoute) {
            applyParsedStudioRoute(studioRoute, routeSetters)
          }
        }
      }
    }

    return cleanup
  }, [
    abortControllerRef,
    liveAnalysisAbortControllerRef,
    setAuthError,
    setAuthNotice,
    setBillingActivationOrderCode,
    setBillingPaymentNotice,
    setFeatureScene,
    setGoogleCallbackState,
    setGoogleIntegrationNotice,
    setHistoryAnalysisMeetingId,
    setHistoryAnalysisScope,
    setIsAuthenticated,
    setMindmapSelectedMeetingId,
    setMindmapSelectedScope,
    setOauthRefreshTick,
    setSessionPlanSyncTick,
    syncUserPreferencesFromServer,
  ])
}
