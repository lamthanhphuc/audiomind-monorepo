import { useCallback, useEffect, useRef, useState } from 'react'

import {
  FULL_GOOGLE_LINK_SCOPES,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GOOGLE_GMAIL_SEND_SCOPE,
  getGoogleStatus,
  hasGoogleCalendarScope,
  hasGoogleGmailSendScope,
  missingGoogleLinkScopes,
  needsGoogleIntegrationGrant,
  startGoogleLink,
  type GoogleStatus,
} from '../../services/googleIntegration'
import {
  closeOAuthTab,
  completeOAuthNavigation,
  prepareOAuthTab,
} from '../../utils/openOAuthWindow'
import { STUDIO_SCENE_PATHS } from '../../utils/studioRouting'

const INTEGRATION_OAUTH_NOTICE = 'Tab xác thực đã mở - hoàn tất ở tab đó, sau đó quay lại tab này.'
const INTEGRATION_OAUTH_BLOCKED_NOTICE = 'Trình duyệt chặn tab mới - đang chuyển hướng trong tab hiện tại.'
const OAUTH_GRANT_POLL_MS = 2000
const OAUTH_GRANT_POLL_MAX_ATTEMPTS = 90

const launchIntegrationOAuth = (
  preparedTab: Window | null,
  authorizationUrl: string,
  setNotice: (value: string | null) => void,
): 'new_tab' | 'same_tab' => {
  if (completeOAuthNavigation(preparedTab, authorizationUrl) === 'new_tab') {
    setNotice(INTEGRATION_OAUTH_NOTICE)
    return 'new_tab'
  }
  setNotice(INTEGRATION_OAUTH_BLOCKED_NOTICE)
  return 'same_tab'
}

type UseGoogleIntegrationStatusOptions = {
  callbackNotice?: string | null
  oauthRefreshTick?: number
  persistPendingSchedule: () => void
}

export function useGoogleIntegrationStatus({
  callbackNotice,
  oauthRefreshTick = 0,
  persistPendingSchedule,
}: UseGoogleIntegrationStatusOptions) {
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(callbackNotice || '')
  const [error, setError] = useState('')
  const oauthInFlightRef = useRef(false)
  const oauthPollCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (callbackNotice) {
      setNotice(callbackNotice)
    }
  }, [callbackNotice])

  const loadStatus = useCallback(async () => {
    setError('')
    setStatusLoading(true)
    try {
      setStatus(await getGoogleStatus())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được trạng thái Google')
    } finally {
      setStatusLoading(false)
    }
  }, [])

  const refreshStatus = useCallback(async (): Promise<GoogleStatus | null> => {
    try {
      const fresh = await getGoogleStatus()
      setStatus(fresh)
      setError('')
      return fresh
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Không tải được trạng thái Google')
      return null
    }
  }, [])

  const stopOAuthGrantPoll = useCallback(() => {
    oauthPollCleanupRef.current?.()
    oauthPollCleanupRef.current = null
  }, [])

  const beginOAuthGrantPoll = useCallback((
    requiredScope: string,
    onGranted?: () => void,
  ) => {
    stopOAuthGrantPoll()
    let cancelled = false
    let attempts = 0

    const isScopeGranted = (fresh: GoogleStatus): boolean => {
      if (requiredScope === GOOGLE_GMAIL_SEND_SCOPE) {
        return hasGoogleGmailSendScope(fresh)
      }
      if (requiredScope === GOOGLE_CALENDAR_EVENTS_SCOPE) {
        return hasGoogleCalendarScope(fresh)
      }
      return !needsGoogleIntegrationGrant(fresh)
    }

    const tick = async () => {
      if (cancelled) return
      if (document.visibilityState !== 'visible') return
      attempts += 1
      const fresh = await refreshStatus()
      if (fresh && isScopeGranted(fresh)) {
        oauthInFlightRef.current = false
        const label = requiredScope === GOOGLE_GMAIL_SEND_SCOPE
          ? 'Gmail'
          : requiredScope === GOOGLE_CALENDAR_EVENTS_SCOPE
            ? 'Calendar'
            : 'Google'
        setNotice(`Đã cấp quyền ${label}.`)
        stopOAuthGrantPoll()
        onGranted?.()
        return
      }
      if (attempts >= OAUTH_GRANT_POLL_MAX_ATTEMPTS) {
        oauthInFlightRef.current = false
        stopOAuthGrantPoll()
      }
    }

    const intervalId = window.setInterval(() => {
      void tick()
    }, OAUTH_GRANT_POLL_MS)
    oauthPollCleanupRef.current = () => {
      cancelled = true
      window.clearInterval(intervalId)
    }

    void tick()
  }, [refreshStatus, stopOAuthGrantPoll])

  const requestGoogleLinkScopes = useCallback(async (
    scopesToRequest: string[],
    onGranted?: () => void,
  ) => {
    if (scopesToRequest.length === 0) {
      throw new Error('At least one Google integration scope is required')
    }
    if (oauthInFlightRef.current) {
      setNotice('Đang chờ bạn hoàn tất cấp quyền ở tab Google - quay lại tab này sau khi xong.')
      return
    }

    oauthInFlightRef.current = true
    const oauthTab = prepareOAuthTab()

    try {
      const authorizationUrl = await startGoogleLink(
        scopesToRequest,
        STUDIO_SCENE_PATHS.integrations,
      )
      const navigation = launchIntegrationOAuth(oauthTab, authorizationUrl, (value) => setNotice(value ?? ''))
      if (navigation === 'new_tab') {
        beginOAuthGrantPoll(scopesToRequest[0], onGranted)
      } else {
        oauthInFlightRef.current = false
      }
    } catch (cause) {
      oauthInFlightRef.current = false
      closeOAuthTab(oauthTab)
      throw cause
    }
  }, [beginOAuthGrantPoll])

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Thao tác Google thất bại')
    } finally {
      setBusy(false)
    }
  }, [])

  const connectGoogleCalendar = useCallback(() => {
    void run(async () => {
      persistPendingSchedule()
      const fresh = await refreshStatus()
      if (fresh && hasGoogleCalendarScope(fresh)) {
        setNotice('Google Calendar đã được kết nối.')
        return
      }
      setNotice('Đang mở tab Google để cấp quyền Calendar…')
      await requestGoogleLinkScopes([GOOGLE_CALENDAR_EVENTS_SCOPE])
    })
  }, [persistPendingSchedule, refreshStatus, requestGoogleLinkScopes, run])

  const connectGoogleGmail = useCallback(() => {
    void run(async () => {
      persistPendingSchedule()
      const fresh = await refreshStatus()
      if (fresh && hasGoogleGmailSendScope(fresh)) {
        setNotice('Gmail đã được kết nối.')
        return
      }
      setNotice('Đang mở tab Google để cấp quyền Gmail…')
      await requestGoogleLinkScopes([GOOGLE_GMAIL_SEND_SCOPE])
    })
  }, [persistPendingSchedule, refreshStatus, requestGoogleLinkScopes, run])

  const connectAllGoogleScopes = useCallback(() => {
    void run(async () => {
      persistPendingSchedule()
      const fresh = await refreshStatus()
      if (fresh && !needsGoogleIntegrationGrant(fresh)) {
        setNotice('Đã có đủ quyền Calendar và Gmail.')
        return
      }

      const scopesToRequest = fresh ? missingGoogleLinkScopes(fresh) : [...FULL_GOOGLE_LINK_SCOPES]
      setNotice('Đang mở tab Google - cấp quyền Calendar và Gmail, hoàn tất ở tab đó rồi quay lại tab này.')
      await requestGoogleLinkScopes(scopesToRequest.length > 0 ? scopesToRequest : [...FULL_GOOGLE_LINK_SCOPES])
    })
  }, [persistPendingSchedule, refreshStatus, requestGoogleLinkScopes, run])

  useEffect(() => { void loadStatus() }, [loadStatus])

  useEffect(() => {
    if (!oauthRefreshTick) return
    oauthInFlightRef.current = false
    stopOAuthGrantPoll()
    void loadStatus()
  }, [loadStatus, oauthRefreshTick, stopOAuthGrantPoll])

  useEffect(() => {
    const reloadWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshStatus().then((fresh) => {
          if (fresh && !needsGoogleIntegrationGrant(fresh)) {
            oauthInFlightRef.current = false
            stopOAuthGrantPoll()
          }
        })
      }
    }
    document.addEventListener('visibilitychange', reloadWhenVisible)
    window.addEventListener('focus', reloadWhenVisible)
    return () => {
      document.removeEventListener('visibilitychange', reloadWhenVisible)
      window.removeEventListener('focus', reloadWhenVisible)
    }
  }, [refreshStatus, stopOAuthGrantPoll])

  useEffect(() => () => {
    stopOAuthGrantPoll()
  }, [stopOAuthGrantPoll])

  return {
    status,
    setStatus,
    statusLoading,
    busy,
    notice,
    setNotice,
    error,
    setError,
    oauthInFlightRef,
    loadStatus,
    refreshStatus,
    requestGoogleLinkScopes,
    run,
    connectGoogleCalendar,
    connectGoogleGmail,
    connectAllGoogleScopes,
    stopOAuthGrantPoll,
  }
}
