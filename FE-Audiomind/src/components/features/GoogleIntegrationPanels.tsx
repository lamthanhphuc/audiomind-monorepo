import { useState, type ReactNode } from 'react'

import {
  MEET_CAPTURE_GUIDE_STEPS,
  MEET_BROWSER_COMPAT_NOTES,
  MEET_WITH_MIC_HEADPHONE_NOTE,
  RECORDING_SOURCE_DESCRIPTIONS,
  type RecordingSource,
} from '../../constants/recordingSource'
import type {
  GoogleCalendarMeetingListItem,
  GoogleCalendarStatus,
  GoogleStatus,
} from '../../services/googleIntegration'
import { LoadingState } from '../ui/LoadingState'

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

export function GoogleCalendarEventCard({
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

export function GoogleCalendarMeetingsTable({ rows, loading, onJoin }: GoogleCalendarMeetingsTableProps) {
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
      <table className="google-calendar-meetings-table ui-data-table">
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

type MeetCaptureGuideProps = {
  calendarStatus: GoogleCalendarStatus | null
  realtimeEnabled: boolean
  onNavigateMeetCapture: (source: RecordingSource) => void
}

export function MeetCaptureGuide({
  calendarStatus,
  realtimeEnabled,
  onNavigateMeetCapture,
}: MeetCaptureGuideProps) {
  return (
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
            onClick={() => onNavigateMeetCapture('browser_tab_with_mic')}
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
              onClick={() => onNavigateMeetCapture('browser_tab_with_mic')}
            >
              Ghi Meet + Microphone
            </button>

            <button
              type="button"
              className="google-btn"
              data-testid="google-meet-capture-tab-only"
              onClick={() => onNavigateMeetCapture('browser_tab')}
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
  )
}

type GoogleAccountStatusProps = {
  status: GoogleStatus | null
  busy: boolean
  oauthEnabled: boolean
  needsGoogleGrant: boolean
  hasFullGoogleGrant: boolean
  onConnectAllGoogleScopes: () => void
  onRevokeGoogleGrant: () => void
  onUnlinkGoogleIdentity: () => void
}

export function GoogleAccountStatus({
  status,
  busy,
  oauthEnabled,
  needsGoogleGrant,
  hasFullGoogleGrant,
  onConnectAllGoogleScopes,
  onRevokeGoogleGrant,
  onUnlinkGoogleIdentity,
}: GoogleAccountStatusProps) {
  return (
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
          onClick={onConnectAllGoogleScopes}
          data-testid="google-full-grant-connect"
        >
          {hasFullGoogleGrant ? 'Cấp lại quyền Google' : 'Cấp quyền Google (Calendar + Gmail)'}
        </button>

        {status?.grantedScopes.length ? (
          <button type="button" className="google-btn" disabled={busy} onClick={onRevokeGoogleGrant}>
            Thu hồi quyền
          </button>
        ) : null}

        {status?.linked ? (
          <button type="button" className="google-btn google-btn--danger" disabled={busy} onClick={onUnlinkGoogleIdentity}>
            Ngắt liên kết
          </button>
        ) : null}
      </div>
    </div>
  )
}

type CalendarSchedulerProps = {
  scheduleMode: 'new' | 'existing'
  onScheduleModeChange: (mode: 'new' | 'existing') => void
  title: string
  onTitleChange: (value: string) => void
  startAt: string
  onStartAtChange: (value: string) => void
  endAt: string
  onEndAtChange: (value: string) => void
  attendees: string
  onAttendeesChange: (value: string) => void
  linkedMeetings: GoogleCalendarMeetingListItem[]
  linkedMeetingsLoading: boolean
  onJoinLinkedMeeting: (row: GoogleCalendarMeetingListItem) => void
  busy: boolean
  googleStatus: GoogleStatus | null
  calendarStatus: GoogleCalendarStatus | null
  linkedCalendarReady: boolean
  renderCalendarEventCard: () => ReactNode
  onCreateMeet: () => void
  onRefreshCalendar: () => void
  onRetryMeetCreation: () => void
}

export function CalendarScheduler({
  scheduleMode,
  onScheduleModeChange,
  title,
  onTitleChange,
  startAt,
  onStartAtChange,
  endAt,
  onEndAtChange,
  attendees,
  onAttendeesChange,
  linkedMeetings,
  linkedMeetingsLoading,
  onJoinLinkedMeeting,
  busy,
  googleStatus,
  calendarStatus,
  linkedCalendarReady,
  renderCalendarEventCard,
  onCreateMeet,
  onRefreshCalendar,
  onRetryMeetCreation,
}: CalendarSchedulerProps) {
  return (
    <div className="google-integration__section google-integration__scheduler">
      <div className="google-integration__section-heading ui-section-header">
        <h2>{scheduleMode === 'existing' ? 'Google Calendar & Meet' : 'Tạo lịch có Google Meet'}</h2>
        <p>
          {scheduleMode === 'existing'
            ? 'Các cuộc họp đã có link Google Meet — bấm Tham gia để mở Meet và chuyển sang ghi âm.'
            : 'Google sẽ gửi lời mời cho các email được thêm.'}
        </p>
      </div>

      <div className="google-integration__mode" role="group" aria-label="Kiểu lịch">
        <button
          type="button"
          className={scheduleMode === 'new' ? 'is-active' : ''}
          onClick={() => onScheduleModeChange('new')}
        >
          Lịch mới
        </button>
        <button
          type="button"
          className={scheduleMode === 'existing' ? 'is-active' : ''}
          onClick={() => onScheduleModeChange('existing')}
        >
          Lịch & Google Meet
        </button>
      </div>

      {scheduleMode === 'new' ? (
        <label>
          Tiêu đề cuộc họp
          <input
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Ví dụ: Họp kế hoạch sprint"
          />
        </label>
      ) : (
        <GoogleCalendarMeetingsTable
          rows={linkedMeetings}
          loading={linkedMeetingsLoading}
          onJoin={onJoinLinkedMeeting}
        />
      )}

      {scheduleMode === 'new' ? (
        <>
          <div className="google-integration__time-grid">
            <label>
              Bắt đầu
              <input
                type="datetime-local"
                value={startAt}
                onChange={(event) => onStartAtChange(event.target.value)}
              />
            </label>
            <label>
              Kết thúc
              <input
                type="datetime-local"
                value={endAt}
                onChange={(event) => onEndAtChange(event.target.value)}
              />
            </label>
          </div>

          <label>
            Người tham dự
            <input
              value={attendees}
              onChange={(event) => onAttendeesChange(event.target.value)}
              placeholder="email@congty.com (tùy chọn, phân cách bằng dấu phẩy)"
            />
          </label>

          <div className="google-integration__actions ui-panel-actions">
            <button
              type="button"
              className="google-btn google-btn--primary"
              disabled={busy || !googleStatus || !title.trim()}
              onClick={onCreateMeet}
            >
              Lên lịch & tạo Meet
            </button>

            {calendarStatus?.creationStatus === 'creating' ? (
              <button type="button" className="google-btn" disabled={busy} onClick={onRefreshCalendar}>
                Kiểm tra trạng thái
              </button>
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
                <span className="google-integration__result-hint">
                  Meet link sẽ xuất hiện khi Google hoàn tất.
                </span>
              ) : null}
            </>
          )}

          {calendarStatus.creationStatus === 'failed' ? (
            <button
              type="button"
              className="google-btn"
              disabled={busy}
              data-testid="google-calendar-retry"
              onClick={onRetryMeetCreation}
            >
              Thử lại
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

