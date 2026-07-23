import type { Meeting } from '../../types'

import {
  needsGoogleIntegrationGrant,
  resolveGoogleConnectionState,
  revokeGoogleGrant,
  unlinkGoogleIdentity,
} from '../../services/googleIntegration'

import { LoadingState } from '../ui/LoadingState'

import {
  type RealtimeMeetCaptureContext,
  type RecordingSource,
} from '../../constants/recordingSource'

import './google-integration.css'
import {
  CalendarScheduler,
  GoogleAccountStatus,
  GoogleCalendarEventCard,
  MeetCaptureGuide,
} from './GoogleIntegrationPanels'
import { useGoogleCalendarScheduler, useGoogleScheduleForm } from './useGoogleCalendarScheduler'
import { useGoogleIntegrationStatus } from './useGoogleIntegrationStatus'

type Props = {

  meetings: Meeting[]

  callbackNotice?: string | null

  oauthEnabled?: boolean

  realtimeEnabled?: boolean

  oauthRefreshTick?: number

  onNavigateRealtimeMeetCapture?: (source: RecordingSource, context?: RealtimeMeetCaptureContext) => void

}



export function GoogleIntegrationSection({
  meetings,
  callbackNotice,
  oauthEnabled = true,
  realtimeEnabled = true,
  oauthRefreshTick = 0,
  onNavigateRealtimeMeetCapture,
}: Props) {

  const scheduleForm = useGoogleScheduleForm({ meetings })
  const {
    scheduleMode,
    setScheduleMode,
    title,
    setTitle,
    startAt,
    setStartAt,
    endAt,
    setEndAt,
    attendees,
    setAttendees,
    selectedMeeting,
    persistPendingSchedule,
  } = scheduleForm

  const {
    status,
    statusLoading,
    busy,
    notice,
    setNotice,
    error,
    oauthInFlightRef,
    loadStatus,
    refreshStatus,
    requestGoogleLinkScopes,
    run,
    connectGoogleCalendar,
    connectGoogleGmail,
  } = useGoogleIntegrationStatus({
    callbackNotice,
    oauthRefreshTick,
    persistPendingSchedule,
  })

  const {
    calendarStatus,
    setCalendarStatus,
    linkedMeetings,
    linkedMeetingsLoading,
    navigateMeetCapture,
    handleJoinLinkedMeeting,
    createMeet,
    retryMeetCreation,
    refreshCalendar,
    linkedCalendarReady,
    calendarEventStartAt,
    calendarEventEndAt,
  } = useGoogleCalendarScheduler({
    ...scheduleForm,
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
  })
  const connectionState = resolveGoogleConnectionState(status)
  const needsGoogleGrant = Boolean(status?.linked && needsGoogleIntegrationGrant(status))
  const connectionLabel = connectionState === 'ready'
    ? 'Đã kết nối'
    : connectionState === 'needs_calendar'
      ? 'Thiếu quyền Calendar'
      : 'Chưa kết nối'



  const renderCalendarEventCard = () => {
    if (!linkedCalendarReady || !calendarStatus?.meetUri) {
      return null
    }
    const cardTitle = scheduleMode === 'new'
      ? title.trim()
      : (selectedMeeting?.title?.trim() || 'Cuộc họp Google Meet')
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



      <MeetCaptureGuide
        calendarStatus={calendarStatus}
        realtimeEnabled={realtimeEnabled}
        onNavigateMeetCapture={navigateMeetCapture}
      />



      <GoogleAccountStatus
        status={status}
        busy={busy}
        oauthEnabled={oauthEnabled}
        onConnectCalendar={connectGoogleCalendar}
        onConnectGmail={connectGoogleGmail}
        onRevokeGoogleGrant={() => run(async () => {
          await revokeGoogleGrant()
          await loadStatus()
          setNotice('Đã thu hồi quyền Calendar. Tài khoản Google vẫn được liên kết.')
        })}
        onUnlinkGoogleIdentity={() => run(async () => {
          await unlinkGoogleIdentity()
          await loadStatus()
          setNotice('Đã ngắt liên kết tài khoản Google.')
        })}
      />



      {needsGoogleGrant && (
        <div className="google-integration__message google-integration__message--warn" role="status" data-testid="google-calendar-grant-required">
          Tài khoản Google đã đăng nhập nhưng chưa đủ quyền. Bấm「Connect」ở Calendar hoặc Gmail — sau khi cấp quyền ở tab Google, quay lại tab này để tiếp tục.
        </div>
      )}

      <CalendarScheduler
        scheduleMode={scheduleMode}
        onScheduleModeChange={setScheduleMode}
        title={title}
        onTitleChange={(value) => {
          setTitle(value)
          setCalendarStatus(null)
        }}
        startAt={startAt}
        onStartAtChange={(value) => {
          setStartAt(value)
          setCalendarStatus(null)
        }}
        endAt={endAt}
        onEndAtChange={(value) => {
          setEndAt(value)
          setCalendarStatus(null)
        }}
        attendees={attendees}
        onAttendeesChange={setAttendees}
        linkedMeetings={linkedMeetings}
        linkedMeetingsLoading={linkedMeetingsLoading}
        onJoinLinkedMeeting={handleJoinLinkedMeeting}
        busy={busy}
        googleStatus={status}
        calendarStatus={calendarStatus}
        linkedCalendarReady={linkedCalendarReady}
        renderCalendarEventCard={renderCalendarEventCard}
        onCreateMeet={createMeet}
        onRefreshCalendar={refreshCalendar}
        onRetryMeetCreation={retryMeetCreation}
      />

    </section>

  )

}

export default GoogleIntegrationSection

