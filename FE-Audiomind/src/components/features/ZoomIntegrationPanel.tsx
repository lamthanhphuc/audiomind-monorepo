import { useCallback, useEffect, useState } from 'react'
import type { RealtimeLanguage } from '../../hooks/useRealtimeMeetingStream'
import {
  getZoomStatus,
  importZoomRecording,
  listZoomRecordings,
  revokeZoomGrant,
  startZoomLink,
  type ZoomRecordingMeeting,
  ZoomIntegrationError,
} from '../../services/zoomIntegration'
import {
  closeOAuthTab,
  completeOAuthNavigation,
  prepareOAuthTab,
} from '../../utils/openOAuthWindow'
import { STUDIO_SCENE_PATHS } from '../../utils/studioRouting'
import { LoadingState } from '../ui/LoadingState'
import { ErrorState } from '../ui/ErrorState'
import { EmptyState } from '../ui/EmptyState'

type Props = {
  busy?: boolean
  uploadLanguage: RealtimeLanguage
  onFileSelected?: (file: File) => void
  onImported?: (meetingId: number, meta: { duplicate: boolean; reused: boolean; processingStarted: boolean }) => void
  callbackNotice?: string | null
  callbackNoticeTone?: 'success' | 'error' | 'info'
  oauthRefreshTick?: number
}

export default function ZoomIntegrationPanel({
  busy = false,
  uploadLanguage,
  onFileSelected = () => {},
  onImported,
  callbackNotice,
  callbackNoticeTone = 'info',
  oauthRefreshTick = 0,
}: Props) {
  const [linked, setLinked] = useState(false)
  const [zoomEmail, setZoomEmail] = useState<string | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [loadingRecordings, setLoadingRecordings] = useState(false)
  const [recordings, setRecordings] = useState<ZoomRecordingMeeting[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(callbackNotice ?? null)
  const [noticeTone, setNoticeTone] = useState<'success' | 'error' | 'info'>(callbackNoticeTone)
  const [importingUuid, setImportingUuid] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true)
    setError(null)
    try {
      const status = await getZoomStatus()
      setLinked(status.linked)
      setZoomEmail(status.zoomEmail)
      if (status.linked) {
        setLoadingRecordings(true)
        const response = await listZoomRecordings()
        setRecordings(response.meetings)
        setLoadingRecordings(false)
      } else {
        setRecordings([])
      }
    } catch (err) {
      setError(err instanceof ZoomIntegrationError ? err.message : 'Không tải được trạng thái Zoom.')
      setLinked(false)
      setRecordings([])
    } finally {
      setLoadingStatus(false)
      setLoadingRecordings(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (!oauthRefreshTick) {
      return
    }
    void refreshStatus()
  }, [oauthRefreshTick, refreshStatus])

  useEffect(() => {
    if (callbackNotice) {
      setNotice(callbackNotice)
      setNoticeTone(callbackNoticeTone)
    }
  }, [callbackNotice, callbackNoticeTone])

  const handleConnect = () => {
    setError(null)
    const oauthTab = prepareOAuthTab()
    void (async () => {
      try {
        const uri = await startZoomLink(`${window.location.origin}${STUDIO_SCENE_PATHS.integrations}`)
        if (completeOAuthNavigation(oauthTab, uri) === 'new_tab') {
          setNotice('Tab xác thực Zoom đã mở — hoàn tất ở tab đó, sau đó quay lại tab này.')
          setNoticeTone('info')
        } else {
          setNotice('Trình duyệt chặn tab mới — đang chuyển hướng trong tab hiện tại.')
          setNoticeTone('info')
        }
      } catch (err) {
        closeOAuthTab(oauthTab)
        setError(err instanceof ZoomIntegrationError ? err.message : 'Không thể bắt đầu kết nối Zoom.')
      }
    })()
  }

  const handleDisconnect = async () => {
    setError(null)
    try {
      await revokeZoomGrant()
      await refreshStatus()
      setNotice('Đã ngắt kết nối Zoom.')
      setNoticeTone('info')
    } catch (err) {
      setError(err instanceof ZoomIntegrationError ? err.message : 'Không thể ngắt kết nối Zoom.')
    }
  }

  const handleImport = async (meeting: ZoomRecordingMeeting) => {
    if (!meeting.uuid || busy) return
    setImportingUuid(meeting.uuid)
    setError(null)
    try {
      const result = await importZoomRecording(meeting.uuid, {
        title: meeting.topic || `Zoom ${meeting.startTime || meeting.uuid}`,
        language: uploadLanguage,
      })
      if (result.meetingId) {
        onImported?.(result.meetingId, {
          duplicate: result.duplicate,
          reused: result.reused,
          processingStarted: result.processingStarted,
        })
      }
      if (result.duplicate && result.reused) {
        setNotice('Recording Zoom đã được phân tích trước đó.')
        setNoticeTone('info')
      } else {
        setNotice('Đã import recording Zoom — đang chạy phân tích tự động.')
        setNoticeTone('success')
      }
    } catch (err) {
      setError(err instanceof ZoomIntegrationError ? err.message : 'Import Zoom recording thất bại.')
    } finally {
      setImportingUuid(null)
    }
  }

  const noticeClass = noticeTone === 'success'
    ? 'ui-state ui-state--success'
    : noticeTone === 'error'
      ? 'ui-state ui-state--error'
      : 'ui-state ui-state--empty'

  return (
    <section className="zoom-import-panel" data-testid="zoom-integration-panel">
      <header>
        <h3>Zoom Cloud</h3>
        <p>
          Kết nối tài khoản Zoom để kéo cloud recording tự động. Import cloud sẽ phân tích ngay;
          file export thủ công dùng khung bên dưới rồi bấm &quot;Phân tích file&quot;.
        </p>
      </header>

      {notice && (
        <p className={noticeClass} data-testid="zoom-integration-notice">{notice}</p>
      )}

      {loadingStatus && <LoadingState message="Đang kiểm tra Zoom…" />}

      {!loadingStatus && !linked && (
        <div className="studio-stack">
          <button
            type="button"
            className="studio-btn studio-btn--primary"
            disabled={busy}
            onClick={() => void handleConnect()}
            data-testid="zoom-connect-button"
          >
            Kết nối Zoom
          </button>
        </div>
      )}

      {!loadingStatus && linked && (
        <div className="studio-stack">
          <p className="studio-muted-text">Đã liên kết: {zoomEmail || 'tài khoản Zoom'}</p>
          <div className="studio-actions-row">
            <button type="button" className="studio-btn studio-btn--secondary" disabled={busy} onClick={() => void refreshStatus()}>
              Tải lại recordings
            </button>
            <button type="button" className="studio-btn studio-btn--secondary" disabled={busy} onClick={() => void handleDisconnect()}>
              Ngắt kết nối
            </button>
          </div>
          {loadingRecordings && <LoadingState message="Đang tải cloud recordings…" />}
          {!loadingRecordings && recordings.length === 0 && (
            <EmptyState message="Chưa có cloud recording trong 30 ngày gần đây. Bạn có thể upload file export thủ công bên dưới." />
          )}
          {!loadingRecordings && recordings.length > 0 && (
            <ul className="integration-recording-list">
              {recordings.map((meeting) => (
                <li key={meeting.uuid} className="integration-recording-list__item">
                  <span>{meeting.topic || meeting.uuid}</span>
                  {meeting.startTime && <span className="studio-muted-text">({meeting.startTime})</span>}
                  <button
                    type="button"
                    className="studio-link-btn"
                    disabled={busy || importingUuid === meeting.uuid}
                    onClick={() => void handleImport(meeting)}
                    data-testid={`zoom-import-${meeting.uuid}`}
                  >
                    {importingUuid === meeting.uuid ? 'Đang import…' : 'Import & phân tích'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <ErrorState title="Zoom" message={error} />}

      <div className="studio-stack">
        <p className="studio-muted-text">Hoặc chọn file export từ Zoom (.mp4, .m4a, .vtt…)</p>
        <label className="integration-import__dropzone">
          <input
            type="file"
            accept=".mp4,.m4a,.mp3,.wav,.vtt,.txt,.csv,audio/*,video/*"
            disabled={busy}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                onFileSelected(file)
                event.target.value = ''
              }
            }}
            data-testid="zoom-import-input"
          />
          <span>Chọn file Zoom export</span>
        </label>
      </div>
    </section>
  )
}
