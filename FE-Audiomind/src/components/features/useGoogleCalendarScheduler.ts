import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Meeting } from '../../types'
import {
  createGoogleCalendarEvent,
  createStandaloneGoogleCalendarEvent,
  getGoogleCalendarStatus,
  listGoogleCalendarMeetings,
  pollGoogleCalendarStatus,
  GOOGLE_CALENDAR_EVENTS_SCOPE,
  GoogleIntegrationError,
  hasGoogleCalendarScope,
  missingGoogleLinkScopes,
  type GoogleCalendarMeetingListItem,
  type GoogleCalendarStatus,
  type GoogleStatus,
} from '../../services/googleIntegration'
import {
  REALTIME_MEET_CAPTURE_TITLE_KEY,
  type RealtimeMeetCaptureContext,
  type RecordingSource,
} from '../../constants/recordingSource'

const PENDING_SCHEDULE_KEY = 'audiomind.google.pending_schedule'

const GOOGLE_CALENDAR_REAUTH_CODES = new Set([
  'GOOGLE_SCOPE_MISSING',
  'GOOGLE_CALENDAR_PERMISSION_DENIED',
  'GOOGLE_REFRESH_TOKEN_REVOKED',
])

type PendingSchedule = {
  mode: 'new' | 'existing'
  title: string
  meetingId: number | ''
  startAt: string
  endAt: string
  attendees: string
}

const toDateTimeLocal = (date: Date) => {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
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

function isGoogleCalendarReauthError(cause: unknown): cause is GoogleIntegrationError {
  return cause instanceof GoogleIntegrationError
    && typeof cause.errorCode === 'string'
    && GOOGLE_CALENDAR_REAUTH_CODES.has(cause.errorCode)
}

type UseGoogleScheduleFormOptions = {
  meetings: Meeting[]
}

export function useGoogleScheduleForm({ meetings }: UseGoogleScheduleFormOptions) {
  const pendingSchedule = useMemo(readPendingSchedule, [])
  const initialStart = useMemo(() => {
    const value = new Date(Date.now() + 60 * 60 * 1000)
    value.setMinutes(0, 0, 0)
    return toDateTimeLocal(value)
  }, [])

  const [scheduleMode, setScheduleMode] = useState<'new' | 'existing'>(pendingSchedule.mode || 'new')
  const [title, setTitle] = useState(pendingSchedule.title || '')
  const [meetingId] = useState<number | ''>(pendingSchedule.meetingId ?? meetings[0]?.id ?? '')
  const [startAt, setStartAt] = useState(pendingSchedule.startAt || initialStart)
  const [endAt, setEndAt] = useState(
    pendingSchedule.endAt || toDateTimeLocal(new Date(new Date(initialStart).getTime() + 60 * 60 * 1000)),
  )
  const [attendees, setAttendees] = useState(pendingSchedule.attendees || '')

  const selectedMeeting = useMemo(
    () => (meetingId ? meetings.find((meeting) => meeting.id === Number(meetingId)) : undefined),
    [meetings, meetingId],
  )

  const persistPendingSchedule = useCallback(() => {
    sessionStorage.setItem(PENDING_SCHEDULE_KEY, JSON.stringify({
      mode: scheduleMode,
      title,
      meetingId,
      startAt,
      endAt,
      attendees,
    } satisfies PendingSchedule))
  }, [attendees, endAt, meetingId, scheduleMode, startAt, title])

  return {
    scheduleMode,
    setScheduleMode,
    title,
    setTitle,
    meetingId,
    startAt,
    setStartAt,
    endAt,
    setEndAt,
    attendees,
    setAttendees,
    selectedMeeting,
    persistPendingSchedule,
  }
}

type UseGoogleCalendarSchedulerOptions = ReturnType<typeof useGoogleScheduleForm> & {
  status: GoogleStatus | null
  statusLoading: boolean
  busy: boolean
  oauthRefreshTick: number
  oauthInFlightRef: React.MutableRefObject<boolean>
  setNotice: (value: string) => void
  refreshStatus: () => Promise<GoogleStatus | null>
  requestGoogleLinkScopes: (scopesToRequest: string[], onGranted?: () => void) => Promise<void>
  run: (action: () => Promise<void>) => Promise<void>
  onNavigateRealtimeMeetCapture?: (source: RecordingSource, context?: RealtimeMeetCaptureContext) => void
}

export function useGoogleCalendarScheduler({
  scheduleMode,
  title,
  meetingId,
  startAt,
  endAt,
  attendees,
  selectedMeeting,
  persistPendingSchedule,
  status,
  statusLoading,
  busy,
  oauthRefreshTick,
  oauthInFlightRef,
  setNotice,
  refreshStatus,
  requestGoogleLinkScopes,
  run,
  onNavigateRealtimeMeetCapture,
}: UseGoogleCalendarSchedulerOptions) {
  const [calendarStatus, setCalendarStatus] = useState<GoogleCalendarStatus | null>(null)
  const [linkedMeetings, setLinkedMeetings] = useState<GoogleCalendarMeetingListItem[]>([])
  const [linkedMeetingsLoading, setLinkedMeetingsLoading] = useState(false)
  const resumeAttemptedRef = useRef(false)
  const createMeetInFlightRef = useRef(false)

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
      || 'Cuộc họp Google Meet'
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
    if (scheduleMode !== 'existing' || statusLoading) return
    void loadLinkedMeetings()
  }, [scheduleMode, statusLoading, status, oauthRefreshTick, loadLinkedMeetings])

  useEffect(() => {
    if (calendarStatus?.creationStatus !== 'creating' || scheduleMode !== 'existing') return
    const targetMeetingId = Number(meetingId)
    if (!targetMeetingId) return

    let cancelled = false
    void pollGoogleCalendarStatus(targetMeetingId, {
      onUpdate: (status) => {
        if (!cancelled) setCalendarStatus(status)
      },
    }).then((finalStatus) => {
      if (cancelled) return
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
  }, [calendarStatus?.creationStatus, meetingId, scheduleMode, setNotice])

  const handleCalendarReauth = useCallback(async (
    cause: GoogleIntegrationError,
    retry: () => void,
  ) => {
    if (oauthInFlightRef.current) return
    persistPendingSchedule()
    const noticeByCode: Record<string, string> = {
      GOOGLE_REFRESH_TOKEN_REVOKED:
        'Google đã thu hồi quyền - hãy liên kết lại tài khoản Google.',
      GOOGLE_CALENDAR_PERMISSION_DENIED:
        'Google từ chối quyền Calendar - hãy cấp lại quyền Calendar rồi thử lại.',
    }
    setNotice(noticeByCode[cause.errorCode ?? '']
      ?? 'Cần quyền Calendar - đang mở tab Google, hoàn tất ở tab đó rồi quay lại tab này.')
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
  }, [oauthInFlightRef, persistPendingSchedule, refreshStatus, requestGoogleLinkScopes, setNotice])

  const createMeet = () => run(async () => {
    if (createMeetInFlightRef.current) return
    createMeetInFlightRef.current = true

    try {
      if (!startAt || !endAt || new Date(endAt) <= new Date(startAt)) {
        throw new Error('Thời gian kết thúc phải sau thời gian bắt đầu')
      }
      if (new Date(endAt) <= new Date()) {
        throw new Error('Thời gian kết thúc phải ở tương lai - chọn khung giờ chưa kết thúc')
      }
      if (scheduleMode === 'new' && !title.trim()) throw new Error('Hãy nhập tiêu đề cuộc họp')
      if (scheduleMode === 'existing' && !meetingId) throw new Error('Hãy chọn một cuộc họp')

      const freshStatus = await refreshStatus()
      if (!hasGoogleCalendarScope(freshStatus)) {
        persistPendingSchedule()
        setNotice('Cần quyền Calendar - đang mở tab Google, hoàn tất ở tab đó rồi quay lại tab này.')
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
          const result = await createStandaloneGoogleCalendarEvent({ title: title.trim(), ...payload })
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
            setNotice('Google đang tạo Meet link...')
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

        setNotice('Google đang tạo Meet link...')
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
  }, [oauthInFlightRef, oauthRefreshTick])

  useEffect(() => {
    if (statusLoading || resumeAttemptedRef.current || busy || oauthInFlightRef.current) return
    const pending = readPendingSchedule()
    if (!pending.startAt || !pending.endAt) return
    if (new Date(pending.endAt) <= new Date()) {
      sessionStorage.removeItem(PENDING_SCHEDULE_KEY)
      return
    }
    if (!status?.linked || !hasGoogleCalendarScope(status)) return
    resumeAttemptedRef.current = true
    void createMeet()
  }, [busy, oauthInFlightRef, oauthRefreshTick, status, statusLoading])

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
      const result = await createStandaloneGoogleCalendarEvent({ title: title.trim(), ...payload })
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
    if (!targetMeetingId) throw new Error('Chưa có cuộc họp để thử lại')
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
      throw new Error('Lịch mới không cần kiểm tra trạng thái - hãy thử tạo lại nếu Meet chưa sẵn sàng')
    }
    const targetMeetingId = Number(meetingId)
    if (!targetMeetingId) throw new Error('Chưa có cuộc họp để kiểm tra')
    const result = await getGoogleCalendarStatus(targetMeetingId)
    setCalendarStatus(result)
    setNotice(result.creationStatus === 'success' ? 'Meet link đã sẵn sàng.' : 'Trạng thái đã được cập nhật.')
  })

  const linkedCalendarReady = calendarStatus?.creationStatus === 'success' && Boolean(calendarStatus.meetUri)

  const calendarEventStartAt = useMemo(() => {
    if (scheduleMode === 'existing' && selectedMeeting?.scheduledStartAt) return selectedMeeting.scheduledStartAt
    return new Date(startAt).toISOString()
  }, [scheduleMode, selectedMeeting, startAt])

  const calendarEventEndAt = useMemo(() => {
    if (scheduleMode === 'existing' && selectedMeeting?.scheduledEndAt) return selectedMeeting.scheduledEndAt
    return new Date(endAt).toISOString()
  }, [scheduleMode, selectedMeeting, endAt])

  return {
    calendarStatus,
    setCalendarStatus,
    linkedMeetings,
    linkedMeetingsLoading,
    selectedMeeting,
    navigateMeetCapture,
    handleJoinLinkedMeeting,
    createMeet,
    retryMeetCreation,
    refreshCalendar,
    linkedCalendarReady,
    calendarEventStartAt,
    calendarEventEndAt,
  }
}
