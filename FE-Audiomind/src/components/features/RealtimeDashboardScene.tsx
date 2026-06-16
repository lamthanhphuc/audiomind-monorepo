import type { MutableRefObject } from 'react'
import { AnalysisPanel } from '../analysis/AnalysisPanel'
import { AnalysisStatusPanel } from '../analysis/AnalysisStatusPanel'
import { AudioRecorderButton } from '../realtime/AudioRecorderButton'
import { RealtimeTranscript } from '../transcript/RealtimeTranscript'
import { ErrorState } from '../ui/ErrorState'
import type { useAudioRecorder } from '../../hooks/useAudioRecorder'
import type { RealtimeLanguage, RealtimeSpeakerMode, TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import type { MicSensitivityMode } from '../../hooks/useVoiceActivityDetection'
import type { AiAnalysis } from '../../types'
import {
  type RecordingSource,
  isBrowserTabRecordingSource,
} from '../../constants/recordingSource'
import { RecordingSourceSelector } from '../realtime/RecordingSourceSelector'

const REALTIME_LANGUAGE_OPTIONS: Array<{ value: RealtimeLanguage; label: string }> = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
  { value: 'multi', label: 'Việt + Anh' },
]

const REALTIME_SPEAKER_MODE_OPTIONS: Array<{ value: RealtimeSpeakerMode; label: string }> = [
  { value: 'single', label: 'Single speaker' },
  { value: 'multiple', label: 'Multiple speakers' },
]

const REALTIME_MIC_SENSITIVITY_OPTIONS: Array<{ value: MicSensitivityMode; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
]

type LiveLifecycleState =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'silent_paused'
  | 'listening_resumed'
  | 'stopping'
  | 'finalizing_recording'
  | 'finalizing_transcript'
  | 'transcript_ready'
  | 'analysis_pending'
  | 'analyzing'
  | 'analysis_completed'
  | 'analysis_failed'
  | 'no_transcript_after_finalize'
  | 'failed_audio_capture'
  | 'stopped_no_analysis'
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
  selectedMicSensitivity: MicSensitivityMode
  selectedRecordingSource: RecordingSource
  noiseSuppressionEnabled: boolean
  noiseSuppressionToggleEnabled: boolean
  noiseSuppressionSupported: boolean
  liveLifecycleState: LiveLifecycleState
  onRealtimeLanguageChange: (value: string) => void
  onRealtimeSpeakerModeChange: (value: string) => void
  onMicSensitivityChange: (value: string) => void
  onRecordingSourceChange: (source: RecordingSource) => void
  onNoiseSuppressionChange: (enabled: boolean) => void
  isRealtimeLanguageSelectorDisabled: boolean
  isRealtimeSpeakerModeSelectorDisabled: boolean
  isRecordingSourceSelectorDisabled: boolean
  liveMeetingId: number | null
  audioRecorder: ReturnType<typeof useAudioRecorder>
  onBeforeStartRecording: (recordingSessionId: number) => Promise<void>
  onChunkReady: (chunk: Blob, sessionId: number) => void | Promise<void>
  onRecordingComplete?: (fullAudio: Blob, sessionId: number) => void
  onStopRequested?: () => void
  gracefulStopRef?: MutableRefObject<(() => Promise<void>) | null>
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
  liveAnalysisMetadata: AiAnalysis | null
  liveAnalysisStatus: 'idle' | 'polling' | 'completed' | 'pending' | 'failed'
  liveAnalysisError: string | null
  showLiveAnalysis: boolean
  onLiveAnalysisRetry: () => void
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

  if (liveLifecycleState === 'no_transcript_after_finalize' || liveLifecycleState === 'stopped_no_analysis') {
    return { label: 'No transcript', tone: 'stopped' }
  }

  if (liveLifecycleState === 'failed_audio_capture') {
    return { label: 'Audio capture failed', tone: 'error' }
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
  selectedMicSensitivity,
  selectedRecordingSource,
  noiseSuppressionEnabled,
  noiseSuppressionToggleEnabled,
  noiseSuppressionSupported,
  liveLifecycleState,
  onRealtimeLanguageChange,
  onRealtimeSpeakerModeChange,
  onMicSensitivityChange,
  onRecordingSourceChange,
  onNoiseSuppressionChange,
  isRealtimeLanguageSelectorDisabled,
  isRealtimeSpeakerModeSelectorDisabled,
  isRecordingSourceSelectorDisabled,
  liveMeetingId,
  audioRecorder,
  onBeforeStartRecording,
  onChunkReady,
  onRecordingComplete,
  onStopRequested,
  gracefulStopRef,
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
  liveAnalysisMetadata,
  liveAnalysisStatus,
  liveAnalysisError,
  showLiveAnalysis,
  onLiveAnalysisRetry,
}: RealtimeDashboardSceneProps) {
  const lifecycleBadge = resolveRealtimeLifecycleBadge(liveLifecycleState, liveAnalysisStatus)
  const isNoTranscriptFinalized =
    liveLifecycleState === 'no_transcript_after_finalize'
    || liveLifecycleState === 'stopped_no_analysis'
  const recorderLifecycleState =
    liveLifecycleState === 'silent_paused' || liveLifecycleState === 'listening_resumed'
      ? 'recording'
      : isNoTranscriptFinalized
        ? liveLifecycleState
        : liveLifecycleState === 'finalizing_transcript'
        || liveLifecycleState === 'transcript_ready'
        || liveLifecycleState === 'analysis_pending'
        || liveLifecycleState === 'analyzing'
        || liveLifecycleState === 'analysis_completed'
        || liveLifecycleState === 'analysis_failed'
        ? 'stopped'
      : liveLifecycleState
  const liveAnalysisPanelStatus = liveAnalysisStatus === 'polling' && !isNoTranscriptFinalized
    ? 'loading'
    : liveAnalysis
      ? 'ready'
      : 'empty'
  const liveAnalysisEmptyMessage = isNoTranscriptFinalized
    ? 'Không có nội dung để phân tích'
    : liveAnalysisStatus === 'pending'
    ? 'Analysis is not ready yet. Use Re-analyze when the transcript is complete.'
    : liveAnalysisStatus === 'failed'
      ? (liveAnalysisMetadata?.transcriptSaved || liveAnalysisMetadata?.retryable
        ? 'Transcript đã lưu. Phân tích AI tạm thời chưa sẵn sàng.'
        : 'Analysis failed temporarily. Retry available.')
      : 'No realtime analysis yet.'
  const isRecordingActive =
    liveLifecycleState === 'connecting'
    || liveLifecycleState === 'recording'
    || liveLifecycleState === 'silent_paused'
    || liveLifecycleState === 'listening_resumed'
    || liveLifecycleState === 'stopping'
    || liveLifecycleState === 'finalizing_recording'
  const isTabAudioSource = isBrowserTabRecordingSource(selectedRecordingSource)
  const isTabOnlySource = selectedRecordingSource === 'browser_tab'
  const noiseSuppressionDisabled = isRecordingActive || !noiseSuppressionSupported || isTabOnlySource
  const noiseSuppressionHelper = isTabOnlySource
    ? 'Không áp dụng khi chỉ ghi âm thanh tab.'
    : isTabAudioSource
    ? 'Áp dụng cho microphone khi chọn Google Meet + Microphone.'
    : !noiseSuppressionSupported
    ? 'Trình duyệt không hỗ trợ tùy chọn này, ghi âm vẫn hoạt động.'
    : isRecordingActive
      ? 'Áp dụng ở lần ghi tiếp theo.'
      : 'Bật để giảm tiếng quạt, bàn phím, tạp âm nền. Tắt nếu giọng bị méo hoặc mất âm.'

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
                <RecordingSourceSelector
                  value={selectedRecordingSource}
                  disabled={isRecordingSourceSelectorDisabled}
                  onChange={onRecordingSourceChange}
                />
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
                <label className="upload-panel__label">
                  <span className="upload-panel__label-text">Độ nhạy mic</span>
                  <select
                    className="upload-panel__select"
                    value={selectedMicSensitivity}
                    onChange={(event) => onMicSensitivityChange(event.target.value)}
                    disabled={liveLifecycleState === 'stopping' || isTabOnlySource}
                  >
                    {REALTIME_MIC_SENSITIVITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {noiseSuppressionToggleEnabled && !isTabOnlySource && (
                  <label className="realtime-toggle">
                    <span className="upload-panel__label-text">Khử nhiễu microphone</span>
                    <span className="realtime-toggle__control">
                      <input
                        type="checkbox"
                        checked={noiseSuppressionEnabled}
                        onChange={(event) => onNoiseSuppressionChange(event.target.checked)}
                        disabled={noiseSuppressionDisabled}
                      />
                      <span>{noiseSuppressionEnabled ? 'On' : 'Off'}</span>
                    </span>
                    <span className="realtime-panel__hint">{noiseSuppressionHelper}</span>
                  </label>
                )}
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
              recordingSource={selectedRecordingSource}
              onBeforeStartRecording={onBeforeStartRecording}
              onChunkReady={onChunkReady}
              onRecordingComplete={onRecordingComplete}
              onStopRequested={onStopRequested}
              gracefulStopRef={gracefulStopRef}
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
            emptyMessage={isNoTranscriptFinalized ? 'Chưa có transcript' : undefined}
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
            <AnalysisStatusPanel
              metadata={liveAnalysisMetadata ?? liveAnalysis}
              busy={liveAnalysisStatus === 'polling'}
              error={liveAnalysisError}
              onReanalyze={onLiveAnalysisRetry}
            />
            <AnalysisPanel
              title="Phân tích realtime"
              analysis={liveAnalysis}
              status={liveAnalysisPanelStatus}
              loadingMessage="Analysis is being generated..."
              errorMessage={liveAnalysisStatus === 'failed' ? liveAnalysisError : null}
              emptyMessage={liveAnalysisEmptyMessage}
              summaryFallback="(đang chờ phân tích)"
              testId="e2e-live-analysis"
            />
          </div>
        )}
      </section>
    </div>
  )
}
