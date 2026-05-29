import { AnalysisPanel } from '../analysis/AnalysisPanel'
import { AudioRecorderButton } from '../realtime/AudioRecorderButton'
import { RealtimeTranscript } from '../transcript/RealtimeTranscript'
import { ErrorState } from '../ui/ErrorState'
import type { useAudioRecorder } from '../../hooks/useAudioRecorder'
import type { RealtimeLanguage, RealtimeSpeakerMode, TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import type { AiAnalysis } from '../../types'

const REALTIME_LANGUAGE_OPTIONS: Array<{ value: RealtimeLanguage; label: string }> = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
  { value: 'multi', label: 'Việt + Anh' },
]

const REALTIME_SPEAKER_MODE_OPTIONS: Array<{ value: RealtimeSpeakerMode; label: string }> = [
  { value: 'single', label: 'Single speaker' },
  { value: 'multiple', label: 'Multiple speakers' },
]

type LiveLifecycleState =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'silent_paused'
  | 'listening_resumed'
  | 'stopping'
  | 'stopped'
  | 'error'

type RealtimeConnectionView = {
  title: string
  detail: string
  closeReason: string | null
  closeReasonIsError: boolean
}

type RealtimeDashboardSceneProps = {
  liveStatusMessage: string | null
  connectionView: RealtimeConnectionView
  selectedRealtimeLanguage: RealtimeLanguage
  selectedRealtimeSpeakerMode: RealtimeSpeakerMode
  liveLifecycleState: LiveLifecycleState
  onRealtimeLanguageChange: (value: string) => void
  onRealtimeSpeakerModeChange: (value: string) => void
  isRealtimeLanguageSelectorDisabled: boolean
  isRealtimeSpeakerModeSelectorDisabled: boolean
  liveMeetingId: number | null
  audioRecorder: ReturnType<typeof useAudioRecorder>
  onBeforeStartRecording: () => Promise<void>
  onChunkReady: (chunk: Blob, sessionId: number) => void | Promise<void>
  onRecordingComplete?: (fullAudio: Blob, sessionId: number) => void
  liveError: string | null
  livePartialWarning: string | null
  showJoinOtherMeeting: boolean
  joinMeetingIdInput: string
  onJoinMeetingIdChange: (value: string) => void
  onJoinMeeting: () => void
  liveTranscriptSegments: TranscriptSegment[]
  liveTranscriptKeywords: string[]
  realtimeKeywordCount: number
  currentUserId: string | null
  connectionViewForAside: RealtimeConnectionView
  liveAnalysis: AiAnalysis | null
  liveAnalysisStatus: 'idle' | 'polling' | 'completed' | 'pending' | 'failed'
  liveAnalysisError: string | null
  showLiveAnalysis: boolean
}

const resolveRealtimeLifecycleBadge = (
  liveLifecycleState: LiveLifecycleState,
  liveAnalysisStatus: 'idle' | 'polling' | 'completed' | 'pending' | 'failed',
): { label: string; tone: 'listening' | 'paused' | 'resumed' | 'stopped' | 'analyzing' | 'idle' | 'error' } => {
  if (liveLifecycleState === 'error') {
    return { label: 'Error', tone: 'error' }
  }

  if (liveLifecycleState === 'silent_paused') {
    return { label: 'Paused', tone: 'paused' }
  }

  if (liveLifecycleState === 'listening_resumed') {
    return { label: 'Resumed', tone: 'resumed' }
  }

  if (liveLifecycleState === 'recording') {
    return { label: 'Listening', tone: 'listening' }
  }

  if (liveLifecycleState === 'stopped') {
    if (liveAnalysisStatus === 'polling') {
      return { label: 'Analyzing', tone: 'analyzing' }
    }
    return { label: 'Stopped', tone: 'stopped' }
  }

  if (liveLifecycleState === 'stopping') {
    return { label: 'Stopped', tone: 'stopped' }
  }

  return { label: 'Idle', tone: 'idle' }
}

export default function RealtimeDashboardScene({
  liveStatusMessage,
  connectionView,
  selectedRealtimeLanguage,
  selectedRealtimeSpeakerMode,
  liveLifecycleState,
  onRealtimeLanguageChange,
  onRealtimeSpeakerModeChange,
  isRealtimeLanguageSelectorDisabled,
  isRealtimeSpeakerModeSelectorDisabled,
  liveMeetingId,
  audioRecorder,
  onBeforeStartRecording,
  onChunkReady,
  onRecordingComplete,
  liveError,
  livePartialWarning,
  showJoinOtherMeeting,
  joinMeetingIdInput,
  onJoinMeetingIdChange,
  onJoinMeeting,
  liveTranscriptSegments,
  liveTranscriptKeywords,
  realtimeKeywordCount,
  currentUserId,
  connectionViewForAside,
  liveAnalysis,
  liveAnalysisStatus,
  liveAnalysisError,
  showLiveAnalysis,
}: RealtimeDashboardSceneProps) {
  const lifecycleBadge = resolveRealtimeLifecycleBadge(liveLifecycleState, liveAnalysisStatus)
  const recorderLifecycleState =
    liveLifecycleState === 'silent_paused' || liveLifecycleState === 'listening_resumed'
      ? 'recording'
      : liveLifecycleState

  return (
    <div className="dashboard-page bg-gray-light">
      <header className="dashboard-header border-b">
        <div className="search-bar">
          <span className="icon">🔍</span>
          <input type="text" placeholder="Tìm bài giảng, môn học, ghi chú..." />
        </div>
        <div className="header-actions">
          <button type="button" className="icon-btn" aria-label="Thông báo">🔔</button>
        </div>
      </header>

      <section className="realtime-panel realtime-panel--dashboard">
        <div className="realtime-hero">
          <div className="realtime-panel__header">
            <div>
              <h2 className="realtime-panel__title">Ghi âm trực tiếp</h2>
              <div className="realtime-panel__status-row">
                <span className={`realtime-status-badge realtime-status-badge--${lifecycleBadge.tone}`}>
                  {lifecycleBadge.label}
                </span>
                <p className="realtime-panel__status">
                  {liveStatusMessage || connectionView.detail || 'Sẵn sàng tạo meeting và bắt đầu ghi âm'}
                </p>
              </div>
              <div className="realtime-panel__settings">
                <label className="upload-panel__label">
                  <span className="upload-panel__label-text">Ngôn ngữ</span>
                  <select
                    className="upload-panel__select"
                    value={selectedRealtimeLanguage}
                    onChange={(event) => onRealtimeLanguageChange(event.target.value)}
                    disabled={isRealtimeLanguageSelectorDisabled}
                  >
                    {REALTIME_LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="upload-panel__label">
                  <span className="upload-panel__label-text">Chế độ người nói</span>
                  <select
                    className="upload-panel__select"
                    value={selectedRealtimeSpeakerMode}
                    onChange={(event) => onRealtimeSpeakerModeChange(event.target.value)}
                    disabled={isRealtimeSpeakerModeSelectorDisabled}
                  >
                    {REALTIME_SPEAKER_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            {liveMeetingId && (
              <span className="realtime-panel__meeting-badge">Meeting #{liveMeetingId}</span>
            )}
          </div>

          <div className="realtime-panel__recorder-wrap">
            <AudioRecorderButton
              recorder={audioRecorder}
              lifecycleState={recorderLifecycleState}
              onBeforeStartRecording={onBeforeStartRecording}
              onChunkReady={onChunkReady}
              onRecordingComplete={onRecordingComplete}
            />
          </div>
        </div>

        {liveError && <ErrorState message={liveError} title="Lỗi realtime" />}
        {livePartialWarning && <div className="warning-banner">{livePartialWarning}</div>}

        {showJoinOtherMeeting && (
          <div className="join-meeting-panel">
            <strong>Tham gia Meeting khác</strong>
            <input
              type="number"
              placeholder="Meeting ID"
              value={joinMeetingIdInput}
              onChange={(event) => onJoinMeetingIdChange(event.target.value)}
            />
            <button type="button" onClick={onJoinMeeting} disabled={!joinMeetingIdInput.trim()}>
              Join Meeting
            </button>
          </div>
        )}

        <div className="realtime-panel__grid">
          <RealtimeTranscript
            segments={liveTranscriptSegments}
            isPaused={liveLifecycleState === 'silent_paused'}
            highlightKeywords={liveTranscriptKeywords}
            maxHeight="620px"
          />

          <aside className="realtime-panel__aside">
            <div className="status-card status-card--live">
              <div className="status-card__label">Connection</div>
              <div className="status-card__value">{connectionViewForAside.title}</div>
              <div className="status-card__detail">{connectionViewForAside.detail}</div>
            </div>
            <div className="status-card">
              <div className="status-card__label">Keywords</div>
              <div className="status-card__value">{realtimeKeywordCount}</div>
            </div>
            <div className="status-card">
              <div className="status-card__label">User</div>
              <div className="status-card__value">{currentUserId || 'Unknown'}</div>
            </div>
          </aside>
        </div>

        {showLiveAnalysis && (
          <div className="realtime-analysis-section">
            <AnalysisPanel
              title="Phân tích realtime"
              analysis={liveAnalysis}
              status={
                liveAnalysisStatus === 'polling'
                  ? 'loading'
                  : liveAnalysis
                    ? 'ready'
                    : 'empty'
              }
              loadingMessage="Đang phân tích transcript sau khi dừng ghi âm..."
              errorMessage={liveAnalysisError}
              emptyMessage="Chưa có kết quả phân tích realtime"
              summaryFallback="(đang chờ phân tích)"
              testId="e2e-live-analysis"
            />
          </div>
        )}
      </section>
    </div>
  )
}
