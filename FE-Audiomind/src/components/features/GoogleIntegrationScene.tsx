import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Meeting } from '../../types'

import {

  createGoogleCalendarEvent,

  createStandaloneGoogleCalendarEvent,

  getGoogleCalendarStatus,

  listGoogleCalendarMeetings,

  pollGoogleCalendarStatus,

  getGoogleStatus,

  GOOGLE_CALENDAR_EVENTS_SCOPE,
  FULL_GOOGLE_LINK_SCOPES,

  GoogleIntegrationError,

  hasGoogleCalendarScope,
  missingGoogleLinkScopes,
  needsGoogleIntegrationGrant,
  resolveGoogleConnectionState,

  revokeGoogleGrant,

  startGoogleLink,

  unlinkGoogleIdentity,

  type GoogleCalendarStatus,

  type GoogleCalendarMeetingListItem,

  type GoogleStatus,

} from '../../services/googleIntegration'

import { LoadingState } from '../ui/LoadingState'

import {
  MEET_CAPTURE_GUIDE_STEPS,
  MEET_BROWSER_COMPAT_NOTES,
  MEET_WITH_MIC_HEADPHONE_NOTE,
  REALTIME_MEET_CAPTURE_TITLE_KEY,
  RECORDING_SOURCE_DESCRIPTIONS,
  type RealtimeMeetCaptureContext,
  type RecordingSource,
} from '../../constants/recordingSource'

import './google-integration.css'
import {
  closeOAuthTab,
  completeOAuthNavigation,
  prepareOAuthTab,
} from '../../utils/openOAuthWindow'
import { STUDIO_SCENE_PATHS } from '../../utils/studioRouting'

const INTEGRATION_OAUTH_NOTICE = 'Tab xác thực đã mở — hoàn tất ở tab đó, sau đó quay lại tab này.'
const INTEGRATION_OAUTH_BLOCKED_NOTICE = 'Trình duyệt chặn tab mới — đang chuyển hướng trong tab hiện tại.'
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



type Props = {

  meetings: Meeting[]

  callbackNotice?: string | null

  oauthEnabled?: boolean

  realtimeEnabled?: boolean

  oauthRefreshTick?: number

  onNavigateRealtimeMeetCapture?: (source: RecordingSource, context?: RealtimeMeetCaptureContext) => void

}



const toDateTimeLocal = (date: Date) => {

  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)

  return shifted.toISOString().slice(0, 16)

}



const PENDING_SCHEDULE_KEY = 'audiomind.google.pending_schedule'

const GOOGLE_CALENDAR_REAUTH_CODES = new Set([
  'GOOGLE_SCOPE_MISSING',
  'GOOGLE_CALENDAR_PERMISSION_DENIED',
  'GOOGLE_REFRESH_TOKEN_REVOKED',
])

function isGoogleCalendarReauthError(cause: unknown): cause is GoogleIntegrationError {
  return cause instanceof GoogleIntegrationError
    && typeof cause.errorCode === 'string'
    && GOOGLE_CALENDAR_REAUTH_CODES.has(cause.errorCode)
}

type PendingSchedule = {

  mode: 'new' | 'existing'

  title: string

  meetingId: number | ''

  startAt: string

  endAt: string

  attendees: string

}



const readPendingSchedule = (): Partial<PendingSchedule> => {

  try {

    return JSON.parse(sessionStorage.getItem(PENDING_SCHEDULE_KEY) || '{}') as Partial<PendingSchedule>

  } catch {

    return {}

  }

}

const parseAttendees = (raw: string): string[] =>
  raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((email) => !/@example\.(com|org)$/i.test(email) && !/@test\.com$/i.test(email))

const AUDIOMIND_CALENDAR_DESCRIPTION = 'Audiomind sẽ tự động phân tích bản ghi sau cuộc họp.'

const formatGoogleStyleSchedule = (startValue: string, endValue: string): string => {
  const start = new Date(startValue)
  const end = new Date(endValue)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Chưa rõ thời gian'
  }
  const dateFmt = new Intl.DateTimeFormat('vi-VN', { weekday: 'long', day: 'numeric', month: 'long' })
  const timeFmt = new Intl.DateTimeFormat('vi-VN', { hour: 'numeric', minute: '2-digit' })
  return `${dateFmt.format(start)} • ${timeFmt.format(start)} – ${timeFmt.format(end)}`
}

const formatMeetLinkLabel = (meetUri: string): string => {
  try {
    const url = new URL(meetUri)
    return `${url.host}${url.pathname}`
  } catch {
    return meetUri.replace(/^https?:\/\//, '')
  }
}

const formatCalendarRowTitle = (title: string, linkedMeeting: boolean): string => {
  const trimmed = title.trim()
  if (!trimmed) return linkedMeeting ? 'Audiomind meeting' : 'Cuộc họp'
  if (!linkedMeeting) return trimmed
  return trimmed.startsWith('Audiomind - ') ? trimmed : `Audiomind - ${trimmed}`
}

type GoogleCalendarEventCardProps = {
  title: string
  startAt: string
  endAt: string
  meetUri: string
  htmlLink: string | null
  calendarLabel: string | null
  onJoinMeet?: () => void
}

function GoogleCalendarEventCard({
  title,
  startAt,
  endAt,
  meetUri,
  htmlLink,
  calendarLabel,
  onJoinMeet,
}: GoogleCalendarEventCardProps) {
  const [copied, setCopied] = useState(false)

  const copyMeetLink = async () => {
    try {
      await navigator.clipboard.writeText(meetUri)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore clipboard errors
    }
  }

  return (
    <div className="google-calendar-event-card google-calendar-event-card--popover" data-testid="google-calendar-event-card">
      <header className="google-calendar-event-card__header">
        <span className="google-calendar-event-card__accent" aria-hidden="true" />
        <div className="google-calendar-event-card__header-text">
          <h3 className="google-calendar-event-card__title">{formatCalendarRowTitle(title, false)}</h3>
          <p className="google-calendar-event-card__time">{formatGoogleStyleSchedule(startAt, endAt)}</p>
        </div>
      </header>

      <div className="google-calendar-event-card__body">
        <a
          className="google-calendar-event-card__meet-cta"
          href={meetUri}
          target="_blank"
          rel="noreferrer"
          data-testid="google-calendar-join-meet"
          onClick={() => onJoinMeet?.()}
        >
          <svg className="google-calendar-event-card__meet-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"
            />
          </svg>
          Tham gia bằng Google Meet
        </a>

        <div className="google-calendar-event-card__link-box">
          <span className="google-calendar-event-card__meet-link-label">{formatMeetLinkLabel(meetUri)}</span>
          <button
            type="button"
            className="google-calendar-event-card__copy-btn"
            data-testid="google-calendar-copy-meet-link"
            onClick={() => { void copyMeetLink() }}
          >
            {copied ? 'Đã copy' : 'Sao chép'}
          </button>
        </div>
      </div>

      <footer className="google-calendar-event-card__footer">
        <p className="google-calendar-event-card__meta-row">
          <svg className="google-calendar-event-card__meta-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z" />
          </svg>
          <span>{AUDIOMIND_CALENDAR_DESCRIPTION}</span>
        </p>

        {calendarLabel ? (
          <p className="google-calendar-event-card__meta-row">
            <svg className="google-calendar-event-card__meta-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11z"
              />
            </svg>
            <span>{calendarLabel}</span>
          </p>
        ) : null}

        {htmlLink ? (
          <a
            className="google-calendar-event-card__calendar-link"
            href={htmlLink}
            target="_blank"
            rel="noreferrer"
            data-testid="google-calendar-open-event"
          >
            Mở trên Google Calendar
          </a>
        ) : null}
      </footer>
    </div>
  )
}



type GoogleCalendarMeetingsTableProps = {
  rows: GoogleCalendarMeetingListItem[]
  loading: boolean
  onJoin: (row: GoogleCalendarMeetingListItem) => void
}

function GoogleCalendarMeetingsTable({ rows, loading, onJoin }: GoogleCalendarMeetingsTableProps) {
  if (loading) {
    return <LoadingState message="Đang tải danh sách cuộc họp…" />
  }

  if (rows.length === 0) {
    return (
      <p className="google-integration__result-hint" data-testid="google-calendar-meetings-empty">
        Chưa có cuộc họp nào có Google Meet — tạo lịch ở tab「Lịch mới」để thêm vào danh sách.
      </p>
    )
  }

  return (
    <div className="google-calendar-meetings-table-wrap" data-testid="google-calendar-meetings-table">
      <table className="google-calendar-meetings-table">
        <thead>
          <tr>
            <th scope="col">Cuộc họp</th>
            <th scope="col">Thời gian</th>
            <th scope="col" className="google-calendar-meetings-table__actions-col">Tham gia</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.linkId} data-testid={`google-calendar-meeting-row-${row.linkId}`}>
              <td className="google-calendar-meetings-table__title">
                <span className="google-calendar-event-card__color-dot" aria-hidden="true" />
                {formatCalendarRowTitle(
                  row.title || (row.meetingId != null ? `Cuộc họp #${row.meetingId}` : 'Cuộc họp'),
                  row.meetingId != null,
                )}
              </td>
              <td className="google-calendar-meetings-table__time">
                {row.scheduledStartAt && row.scheduledEndAt
                  ? formatGoogleStyleSchedule(row.scheduledStartAt, row.scheduledEndAt)
                  : '—'}
              </td>
              <td className="google-calendar-meetings-table__actions">
                {row.meetUri ? (
                  <button
                    type="button"
                    className="google-calendar-meetings-table__join-btn"
                    data-testid={`google-calendar-join-row-${row.linkId}`}
                    onClick={() => onJoin(row)}
                  >
                    Tham gia
                  </button>
                ) : (
                  <span className="google-integration__result-hint">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}



export function GoogleIntegrationSection({
  meetings,
  callbackNotice,
  oauthEnabled = true,
  realtimeEnabled = true,
  oauthRefreshTick = 0,
  onNavigateRealtimeMeetCapture,
}: Props) {

  const pendingSchedule = useMemo(readPendingSchedule, [])

  const initialStart = useMemo(() => {

    const value = new Date(Date.now() + 60 * 60 * 1000)

    value.setMinutes(0, 0, 0)

    return toDateTimeLocal(value)

  }, [])

  const [status, setStatus] = useState<GoogleStatus | null>(null)

  const [statusLoading, setStatusLoading] = useState(true)

  const [busy, setBusy] = useState(false)

  const [notice, setNotice] = useState(callbackNotice || '')

  useEffect(() => {
    if (callbackNotice) {
      setNotice(callbackNotice)
    }
  }, [callbackNotice])

  const [error, setError] = useState('')

  const [scheduleMode, setScheduleMode] = useState<'new' | 'existing'>(pendingSchedule.mode || 'new')

  const [title, setTitle] = useState(pendingSchedule.title || '')

  const [meetingId] = useState<number | ''>(pendingSchedule.meetingId ?? meetings[0]?.id ?? '')

  const [startAt, setStartAt] = useState(pendingSchedule.startAt || initialStart)

  const [endAt, setEndAt] = useState(

    pendingSchedule.endAt || toDateTimeLocal(new Date(new Date(initialStart).getTime() + 60 * 60 * 1000)),

  )

  const [attendees, setAttendees] = useState(pendingSchedule.attendees || '')

  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus | null>(null)
  const [linkedMeetings, setLinkedMeetings] = useState<GoogleCalendarMeetingListItem[]>([])
  const [linkedMeetingsLoading, setLinkedMeetingsLoading] = useState(false)
  const resumeAttemptedRef = useRef(false)
  const oauthInFlightRef = useRef(false)
  const createMeetInFlightRef = useRef(false)
  const oauthPollCleanupRef = useRef<(() => void) | null>(null)

  const selectedMeeting = useMemo(
    () => (meetingId ? meetings.find((meeting) => meeting.id === Number(meetingId)) : undefined),
    [meetings, meetingId],
  )

  const resolveMeetCaptureTitle = useCallback((): string => {
    if (title.trim()) return title.trim()
    if (selectedMeeting?.title?.trim()) return selectedMeeting.title.trim()
    return ''
  }, [title, selectedMeeting])

  const navigateMeetCapture = useCallback((source: RecordingSource) => {
    const captureTitle = resolveMeetCaptureTitle()
    try {
      if (captureTitle) {
        sessionStorage.setItem(REALTIME_MEET_CAPTURE_TITLE_KEY, captureTitle)
      }
    } catch {
      // ignore storage errors
    }
    onNavigateRealtimeMeetCapture?.(source, captureTitle ? { title: captureTitle } : undefined)
  }, [onNavigateRealtimeMeetCapture, resolveMeetCaptureTitle])

  const handleJoinLinkedMeeting = useCallback((row: GoogleCalendarMeetingListItem) => {
    const captureTitle = row.title?.trim()
      || (row.meetingId != null ? `Cuộc họp #${row.meetingId}` : 'Cuộc họp')
    try {
      sessionStorage.setItem(REALTIME_MEET_CAPTURE_TITLE_KEY, captureTitle)
    } catch {
      // ignore storage errors
    }
    onNavigateRealtimeMeetCapture?.('browser_tab_with_mic', { title: captureTitle })
    if (row.meetUri) {
      window.open(row.meetUri, '_blank', 'noopener,noreferrer')
    }
  }, [onNavigateRealtimeMeetCapture])

  const loadLinkedMeetings = useCallback(async () => {
    if (!hasGoogleCalendarScope(status)) {
      setLinkedMeetings([])
      return
    }
    setLinkedMeetingsLoading(true)
    try {
      setLinkedMeetings(await listGoogleCalendarMeetings())
    } catch {
      setLinkedMeetings([])
    } finally {
      setLinkedMeetingsLoading(false)
    }
  }, [status])

  useEffect(() => {
    if (scheduleMode !== 'existing' || statusLoading) {
      return
    }
    void loadLinkedMeetings()
  }, [scheduleMode, statusLoading, status, oauthRefreshTick, loadLinkedMeetings])



  const loadStatus = async () => {

    setError('')

    setStatusLoading(true)

    try {

      setStatus(await getGoogleStatus())

    } catch (cause) {

      setError(cause instanceof Error ? cause.message : 'Không tải được trạng thái Google')

    } finally {

      setStatusLoading(false)

    }

  }

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

  const beginOAuthGrantPoll = useCallback((onGranted?: () => void) => {
    stopOAuthGrantPoll()
    let cancelled = false
    let attempts = 0

    const tick = async () => {
      if (cancelled) return
      if (document.visibilityState !== 'visible') return
      attempts += 1
      const fresh = await refreshStatus()
      if (fresh && !needsGoogleIntegrationGrant(fresh)) {
        oauthInFlightRef.current = false
        setNotice('Đã cấp đủ quyền Google (Calendar + Gmail).')
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
    if (oauthInFlightRef.current) {
      setNotice('Đang chờ bạn hoàn tất cấp quyền ở tab Google — quay lại tab này sau khi xong.')
      return
    }

    oauthInFlightRef.current = true
    const oauthTab = prepareOAuthTab()

    try {
      const authorizationUrl = await startGoogleLink(
        scopesToRequest.length > 0 ? scopesToRequest : [GOOGLE_CALENDAR_EVENTS_SCOPE],
        STUDIO_SCENE_PATHS.integrations,
      )
      const navigation = launchIntegrationOAuth(oauthTab, authorizationUrl, (value) => setNotice(value ?? ''))
      if (navigation === 'new_tab') {
        beginOAuthGrantPoll(onGranted)
      } else {
        oauthInFlightRef.current = false
      }
    } catch (cause) {
      oauthInFlightRef.current = false
      closeOAuthTab(oauthTab)
      throw cause
    }
  }, [beginOAuthGrantPoll])



  useEffect(() => { void loadStatus() }, [])

  useEffect(() => {
    if (!oauthRefreshTick) {
      return
    }
    oauthInFlightRef.current = false
    stopOAuthGrantPoll()
    void loadStatus()
  }, [oauthRefreshTick, stopOAuthGrantPoll])

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

  useEffect(() => {
    if (calendarStatus?.creationStatus !== 'creating' || scheduleMode !== 'existing') {
      return
    }
    const targetMeetingId = Number(meetingId)
    if (!targetMeetingId) {
      return
    }
    let cancelled = false
    void pollGoogleCalendarStatus(targetMeetingId, {
      onUpdate: (status) => {
        if (!cancelled) {
          setCalendarStatus(status)
        }
      },
    }).then((finalStatus) => {
      if (cancelled) {
        return
      }
      setCalendarStatus(finalStatus)
      if (finalStatus.creationStatus === 'success') {
        sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
        setNotice('Meet link đã sẵn sàng.')
      } else if (finalStatus.creationStatus === 'failed') {
        setNotice('Google không tạo được Meet link. Vui lòng thử lại.')
      }
    })
    return () => {
      cancelled = true
    }
  }, [calendarStatus?.creationStatus, scheduleMode, meetingId])



  const run = async (action: () => Promise<void>) => {

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

  }



  const persistPendingSchedule = () => {

    sessionStorage.setItem(PENDING_SCHEDULE_KEY, JSON.stringify({

      mode: scheduleMode,

      title,

      meetingId,

      startAt,

      endAt,

      attendees,

    } satisfies PendingSchedule))

  }



  const connectAllGoogleScopes = () => {
    void run(async () => {

      persistPendingSchedule()

      const fresh = await refreshStatus()
      if (fresh && !needsGoogleIntegrationGrant(fresh)) {
        setNotice('Đã có đủ quyền Calendar và Gmail.')
        return
      }

      const scopesToRequest = fresh ? missingGoogleLinkScopes(fresh) : [...FULL_GOOGLE_LINK_SCOPES]
      setNotice('Đang mở tab Google — cấp quyền Calendar và Gmail, hoàn tất ở tab đó rồi quay lại tab này.')

      await requestGoogleLinkScopes(
        scopesToRequest.length > 0 ? scopesToRequest : [...FULL_GOOGLE_LINK_SCOPES],
        () => {
          resumeAttemptedRef.current = false
        },
      )

    })
  }



  const handleCalendarReauth = useCallback(async (
    cause: GoogleIntegrationError,
    retry: () => void,
  ) => {
    if (oauthInFlightRef.current) {
      return
    }
    persistPendingSchedule()
    const noticeByCode: Record<string, string> = {
      GOOGLE_REFRESH_TOKEN_REVOKED:
        'Google đã thu hồi quyền — hãy liên kết lại tài khoản Google.',
      GOOGLE_CALENDAR_PERMISSION_DENIED:
        'Google từ chối quyền Calendar — hãy cấp lại quyền Calendar rồi thử lại.',
    }
    setNotice(noticeByCode[cause.errorCode ?? '']
      ?? 'Cần quyền Calendar — đang mở tab Google, hoàn tất ở tab đó rồi quay lại tab này.')
    const latest = await refreshStatus()
    const scopesToRequest = cause.missingScopes.length
      ? cause.missingScopes
      : latest
        ? missingGoogleLinkScopes(latest)
        : [GOOGLE_CALENDAR_EVENTS_SCOPE]
    await requestGoogleLinkScopes(
      scopesToRequest.length > 0 ? scopesToRequest : [GOOGLE_CALENDAR_EVENTS_SCOPE],
      () => {
        resumeAttemptedRef.current = true
        void retry()
      },
    )
  }, [refreshStatus, requestGoogleLinkScopes])



  const createMeet = () => run(async () => {

    if (createMeetInFlightRef.current) {
      return
    }
    createMeetInFlightRef.current = true

    try {

    if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) {

      throw new Error('Thời gian kết thúc phải sau thời gian bắt đầu')

    }

    if (new Date(endAt) <= new Date()) {

      throw new Error('Thời gian kết thúc phải ở tương lai — chọn khung giờ chưa kết thúc')

    }

    if (scheduleMode === 'new' && !title.trim()) throw new Error('Hãy nhập tiêu đề cuộc họp')

    if (scheduleMode === 'existing' && !meetingId) throw new Error('Hãy chọn một cuộc họp')

    const freshStatus = await refreshStatus()

    if (!hasGoogleCalendarScope(freshStatus)) {

      persistPendingSchedule()

      setNotice('Cần quyền Calendar — đang mở tab Google, hoàn tất ở tab đó rồi quay lại tab này.')

      const scopesToRequest = freshStatus
        ? missingGoogleLinkScopes(freshStatus)
        : [GOOGLE_CALENDAR_EVENTS_SCOPE]

      await requestGoogleLinkScopes(
        scopesToRequest.length > 0 ? scopesToRequest : [GOOGLE_CALENDAR_EVENTS_SCOPE],
        () => {
          resumeAttemptedRef.current = true
          void createMeet()
        },
      )

      return

    }

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh'

    const payload = {

      startDateTime: new Date(startAt).toISOString(),

      endDateTime: new Date(endAt).toISOString(),

      timeZone,

      attendees: parseAttendees(attendees),

    }

    if (scheduleMode === 'new') {
      try {
        const result = await createStandaloneGoogleCalendarEvent({
          title: title.trim(),
          ...payload,
        })
        setCalendarStatus({
          meetingId: 0,
          creationStatus: result.creationStatus,
          conferenceStatus: result.conferenceStatus,
          googleCalendarEventId: result.googleCalendarEventId,
          meetUri: result.meetUri,
          hangoutLink: result.hangoutLink,
          htmlLink: result.htmlLink,
          errorCode: result.errorCode,
        })
        if (result.creationStatus === 'success') {
          sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
          setNotice('Đã tạo lịch và Google Meet.')
          void loadLinkedMeetings()
        } else {
          setNotice('Google đang tạo Meet link…')
        }
      } catch (cause) {
        if (isGoogleCalendarReauthError(cause)) {
          await handleCalendarReauth(cause, createMeet)
          return
        }
        throw cause
      }
      return
    }

    const targetMeetingId = Number(meetingId)

    if (!targetMeetingId) throw new Error('Hãy chọn một cuộc họp')

    try {

      const result = await createGoogleCalendarEvent(targetMeetingId, payload)

      setCalendarStatus(result)

      if (result.creationStatus === 'success') {
        sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
        setNotice('Đã tạo lịch và Google Meet.')
        return
      }

      setNotice('Google đang tạo Meet link…')

      const polled = await pollGoogleCalendarStatus(targetMeetingId, { onUpdate: setCalendarStatus })
      setCalendarStatus(polled)
      if (polled.creationStatus === 'success') {
        sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
        setNotice('Meet link đã sẵn sàng.')
      }

    } catch (cause) {

      if (isGoogleCalendarReauthError(cause)) {
        await handleCalendarReauth(cause, createMeet)
        return
      }

      throw cause

    }

    } finally {
      createMeetInFlightRef.current = false
    }

  })

  useEffect(() => {
    if (oauthRefreshTick) {
      resumeAttemptedRef.current = false
      oauthInFlightRef.current = false
    }
  }, [oauthRefreshTick])

  useEffect(() => {
    if (statusLoading || resumeAttemptedRef.current || busy || oauthInFlightRef.current) {
      return
    }
    const pending = readPendingSchedule()
    if (!pending.startAt || !pending.endAt) {
      return
    }
    if (new Date(pending.endAt) <= new Date()) {
      sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
      return
    }
    if (!status?.linked) {
      return
    }
    if (!hasGoogleCalendarScope(status)) {
      return
    }
    resumeAttemptedRef.current = true
    void createMeet()
  }, [statusLoading, status, busy, oauthRefreshTick])

  const retryMeetCreation = () => run(async () => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ho_Chi_Minh'
    const payload = {
      startDateTime: new Date(startAt).toISOString(),
      endDateTime: new Date(endAt).toISOString(),
      timeZone,
      attendees: parseAttendees(attendees),
    }

    if (scheduleMode === 'new') {
      if (!title.trim()) throw new Error('Hãy nhập tiêu đề cuộc họp')
      const result = await createStandaloneGoogleCalendarEvent({
        title: title.trim(),
        ...payload,
      })
      setCalendarStatus({
        meetingId: 0,
        creationStatus: result.creationStatus,
        conferenceStatus: result.conferenceStatus,
        googleCalendarEventId: result.googleCalendarEventId,
        meetUri: result.meetUri,
        hangoutLink: result.hangoutLink,
        htmlLink: result.htmlLink,
        errorCode: result.errorCode,
      })
      if (result.creationStatus === 'success') {
        sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
        setNotice('Meet link đã sẵn sàng.')
      }
      return
    }

    const targetMeetingId = Number(meetingId)
    if (!targetMeetingId) {
      throw new Error('Chưa có cuộc họp để thử lại')
    }
    if (calendarStatus?.googleCalendarEventId) {
      const polled = await pollGoogleCalendarStatus(targetMeetingId, { onUpdate: setCalendarStatus })
      setCalendarStatus(polled)
      if (polled.creationStatus === 'success') {
        sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
        setNotice('Meet link đã sẵn sàng.')
      } else if (polled.creationStatus === 'failed') {
        setNotice('Google không tạo được Meet link. Vui lòng thử lại.')
      }
      return
    }
    const result = await createGoogleCalendarEvent(targetMeetingId, payload)
    setCalendarStatus(result)
    if (result.creationStatus === 'success') {
      sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
      setNotice('Đã tạo lịch và Google Meet.')
      return
    }
    const polled = await pollGoogleCalendarStatus(targetMeetingId, { onUpdate: setCalendarStatus })
    setCalendarStatus(polled)
    if (polled.creationStatus === 'success') {
      sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
      setNotice('Meet link đã sẵn sàng.')
    }
  })

  const refreshCalendar = () => run(async () => {

    if (scheduleMode === 'new') {
      throw new Error('Lịch mới không cần kiểm tra trạng thái — hãy thử tạo lại nếu Meet chưa sẵn sàng')
    }

    const targetMeetingId = Number(meetingId)

    if (!targetMeetingId) throw new Error('Chưa có cuộc họp để kiểm tra')

    const result = await getGoogleCalendarStatus(targetMeetingId)

    setCalendarStatus(result)

    setNotice(result.creationStatus === 'success' ? 'Meet link đã sẵn sàng.' : 'Trạng thái đã được cập nhật.')

  })



  const hasFullGoogleGrant = status ? !needsGoogleIntegrationGrant(status) : false
  const connectionState = resolveGoogleConnectionState(status)
  const needsGoogleGrant = Boolean(status?.linked && needsGoogleIntegrationGrant(status))
  const connectionLabel = connectionState === 'ready'
    ? 'Đã kết nối'
    : connectionState === 'needs_calendar'
      ? 'Thiếu quyền Calendar'
      : 'Chưa kết nối'



  const linkedCalendarReady = calendarStatus?.creationStatus === 'success' && Boolean(calendarStatus.meetUri)

  const calendarEventStartAt = useMemo(() => {
    if (scheduleMode === 'existing' && selectedMeeting?.scheduledStartAt) {
      return selectedMeeting.scheduledStartAt
    }
    return new Date(startAt).toISOString()
  }, [scheduleMode, selectedMeeting, startAt])

  const calendarEventEndAt = useMemo(() => {
    if (scheduleMode === 'existing' && selectedMeeting?.scheduledEndAt) {
      return selectedMeeting.scheduledEndAt
    }
    return new Date(endAt).toISOString()
  }, [scheduleMode, selectedMeeting, endAt])

  const renderCalendarEventCard = () => {
    if (!linkedCalendarReady || !calendarStatus?.meetUri) {
      return null
    }
    const cardTitle = scheduleMode === 'new'
      ? title.trim()
      : (selectedMeeting?.title?.trim() || `Cuộc họp #${meetingId}`)
    return (
      <GoogleCalendarEventCard
        title={cardTitle}
        startAt={calendarEventStartAt}
        endAt={calendarEventEndAt}
        meetUri={calendarStatus.meetUri}
        htmlLink={calendarStatus.htmlLink}
        calendarLabel={status?.googleEmail ?? null}
        onJoinMeet={() => navigateMeetCapture('browser_tab_with_mic')}
      />
    )
  }

  if (statusLoading) {

    return (

      <section className="google-integration" data-testid="google-integration-loading">

        <LoadingState message="Đang tải trạng thái Google…" />

      </section>

    )

  }



  return (

    <section className="google-integration" aria-labelledby="google-integration-title">

      <header className="google-integration__header">

        <div>

          <p className="google-integration__eyebrow">TÍCH HỢP</p>

          <h1 id="google-integration-title">Lịch Google & Meet</h1>

          <p className="google-integration__subtitle">
            Lên lịch Meet qua Calendar hoặc ghi âm tab Google Meet trực tiếp — hỗ trợ tiếng Việt qua Deepgram.
          </p>

        </div>

        <span className={`google-integration__state ${connectionState === 'ready' ? 'is-linked' : ''} ${connectionState === 'needs_calendar' ? 'needs-grant' : ''}`}>

          {connectionLabel}

        </span>

      </header>



      {(notice || error) && (

        <div className={`google-integration__message ${error ? 'is-error' : ''}`} role="status">

          {error || notice}

        </div>

      )}

      {!oauthEnabled && (
        <div className="google-integration__message" data-testid="google-oauth-disabled" role="status">
          Google OAuth chưa bật trên môi trường này. Admin cần cấu hình GOOGLE_OAUTH_ENABLED và VITE_GOOGLE_LOGIN_ENABLED.
        </div>
      )}



      <div className="google-integration__meet-capture" data-testid="google-meet-capture-card">

        <div className="google-integration__meet-capture-copy">

          <p className="google-integration__meet-capture-eyebrow">KHUYẾN NGHỊ CHO TIẾNG VIỆT</p>

          <h2>Ghi âm Google Meet</h2>

          <p>
            Transcript native của Google Meet chưa hỗ trợ tiếng Việt. Audiomind ghi âm từ tab Meet
            (hoặc Meet + micro) rồi chuyển giọng nói sang Deepgram và phân tích bằng Gemini.
          </p>

          <ol className="google-integration__meet-steps">

            {MEET_CAPTURE_GUIDE_STEPS.map((step) => (

              <li key={step}>{step}</li>

            ))}

          </ol>

          <p className="google-integration__meet-note">{MEET_WITH_MIC_HEADPHONE_NOTE}</p>

          <ul className="google-integration__meet-compat" data-testid="google-meet-browser-compat">
            {MEET_BROWSER_COMPAT_NOTES.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>

          {calendarStatus?.meetUri ? (

            <a
              className="google-integration__meet-link"
              href={calendarStatus.meetUri}
              target="_blank"
              rel="noreferrer"
              data-testid="google-meet-capture-open-link"
              onClick={() => navigateMeetCapture('browser_tab_with_mic')}
            >
              Mở link Meet vừa tạo
            </a>

          ) : null}

        </div>

        <div className="google-integration__meet-capture-actions">

          {realtimeEnabled ? (

            <>

              <button
                type="button"
                className="google-btn google-btn--primary"
                data-testid="google-meet-capture-with-mic"
                onClick={() => navigateMeetCapture('browser_tab_with_mic')}
              >
                Ghi Meet + Microphone
              </button>

              <button
                type="button"
                className="google-btn"
                data-testid="google-meet-capture-tab-only"
                onClick={() => navigateMeetCapture('browser_tab')}
              >
                Chỉ ghi tab Meet
              </button>

              <p className="google-integration__meet-source-hint">
                {RECORDING_SOURCE_DESCRIPTIONS.browser_tab_with_mic}
              </p>

            </>

          ) : (

            <p className="google-integration__meet-source-hint">
              Ghi âm trực tiếp chưa bật trên môi trường này (VITE_REALTIME_ENABLED).
            </p>

          )}

        </div>

      </div>



      <div className="google-integration__section">

        <div>

          <h2>Tài khoản Google</h2>

          <p>{status?.googleEmail || 'Kết nối Google để cấp quyền cho Calendar, Meet và gửi email mời.'}</p>

          {status?.grantedScopes && status.grantedScopes.length > 0 && (

            <div className="google-integration__scopes">

              {status.grantedScopes.map((scope) => (

                <span key={scope} className="google-integration__scope-chip">{scope.split('/').pop()}</span>

              ))}

            </div>

          )}

        </div>

        <div className="google-integration__actions">

          <button
            type="button"
            className={`google-btn google-btn--primary ${needsGoogleGrant ? 'google-btn--emphasis' : ''}`}
            disabled={busy || !oauthEnabled}
            onClick={connectAllGoogleScopes}
            data-testid="google-full-grant-connect"
          >

            {hasFullGoogleGrant ? 'Cấp lại quyền Google' : 'Cấp quyền Google (Calendar + Gmail)'}

          </button>

          {status?.grantedScopes.length ? (

            <button type="button" className="google-btn" disabled={busy} onClick={() => run(async () => {

              await revokeGoogleGrant(); await loadStatus(); setNotice('Đã thu hồi quyền Calendar. Tài khoản Google vẫn được liên kết.')

            })}>Thu hồi quyền</button>

          ) : null}

          {status?.linked ? (

            <button type="button" className="google-btn google-btn--danger" disabled={busy} onClick={() => run(async () => {

              await unlinkGoogleIdentity(); await loadStatus(); setNotice('Đã ngắt liên kết tài khoản Google.')

            })}>Ngắt liên kết</button>

          ) : null}

        </div>

      </div>



      {needsGoogleGrant && (
        <div className="google-integration__message google-integration__message--warn" role="status" data-testid="google-calendar-grant-required">
          Tài khoản Google đã đăng nhập nhưng chưa đủ quyền. Bấm「Cấp quyền Google (Calendar + Gmail)」hoặc「Lên lịch & tạo Meet」— sau khi cấp quyền ở tab Google, quay lại tab này để tiếp tục.
        </div>
      )}

      <div className="google-integration__section google-integration__scheduler">

        <div className="google-integration__section-heading">

          <h2>{scheduleMode === 'existing' ? 'Google Calendar & Meet' : 'Tạo lịch có Google Meet'}</h2>

          <p>{scheduleMode === 'existing'
            ? 'Các cuộc họp đã có link Google Meet — bấm Tham gia để mở Meet và chuyển sang ghi âm.'
            : 'Google sẽ gửi lời mời cho các email được thêm.'}</p>

        </div>

        <div className="google-integration__mode" role="group" aria-label="Kiểu lịch">

          <button type="button" className={scheduleMode === 'new' ? 'is-active' : ''} onClick={() => setScheduleMode('new')}>Lịch mới</button>

          <button type="button" className={scheduleMode === 'existing' ? 'is-active' : ''} onClick={() => setScheduleMode('existing')}>Lịch & Google Meet</button>

        </div>

        {scheduleMode === 'new' ? (

          <label>

            Tiêu đề cuộc họp

            <input value={title} onChange={event => { setTitle(event.target.value); setCalendarStatus(null) }} placeholder="Ví dụ: Họp kế hoạch sprint" />

          </label>

        ) : (
          <GoogleCalendarMeetingsTable
            rows={linkedMeetings}
            loading={linkedMeetingsLoading}
            onJoin={handleJoinLinkedMeeting}
          />
        )}

        {scheduleMode === 'new' ? (
        <>
        <div className="google-integration__time-grid">

          <label>Bắt đầu<input type="datetime-local" value={startAt} onChange={event => { setStartAt(event.target.value); setCalendarStatus(null) }} /></label>

          <label>Kết thúc<input type="datetime-local" value={endAt} onChange={event => { setEndAt(event.target.value); setCalendarStatus(null) }} /></label>

        </div>

        <label>

          Người tham dự

          <input value={attendees} onChange={event => setAttendees(event.target.value)} placeholder="email@congty.com (tùy chọn, phân cách bằng dấu phẩy)" />

        </label>

        <div className="google-integration__actions">

          <button

            type="button"

            className="google-btn google-btn--primary"

            disabled={busy || !status || !title.trim()}

            onClick={createMeet}

          >Lên lịch & tạo Meet</button>

          {calendarStatus?.creationStatus === 'creating' ? (

            <button type="button" className="google-btn" disabled={busy} onClick={refreshCalendar}>Kiểm tra trạng thái</button>

          ) : null}

        </div>
        </>
        ) : null}

        {scheduleMode === 'new' && calendarStatus ? (
          <div className="google-integration__result" data-testid="google-calendar-result">
            {calendarStatus.creationStatus === 'creating' ? (
              <LoadingState message="Google đang tạo Meet…" />
            ) : null}

            {linkedCalendarReady ? renderCalendarEventCard() : (
              <>
                {calendarStatus.creationStatus === 'failed' && (
                  <p className="google-integration__result-hint" data-testid="google-calendar-error">
                    {calendarStatus.errorCode || 'Google không tạo được Meet link.'}
                  </p>
                )}

                {calendarStatus.creationStatus === 'creating' ? (
                  <span className="google-integration__result-hint">Meet link sẽ xuất hiện khi Google hoàn tất.</span>
                ) : null}
              </>
            )}

            {calendarStatus.creationStatus === 'failed' ? (
              <button
                type="button"
                className="google-btn"
                disabled={busy}
                data-testid="google-calendar-retry"
                onClick={retryMeetCreation}
              >
                Thử lại
              </button>
            ) : null}
          </div>
        ) : null}

      </div>

    </section>

  )

}

export default GoogleIntegrationSection

