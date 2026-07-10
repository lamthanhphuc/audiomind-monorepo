import { useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { AnalysisPanel } from '../analysis/AnalysisPanel'
import { AnalysisStatusPanel } from '../analysis/AnalysisStatusPanel'
import { collectEvidenceMatchesFromAnalysis } from '../../utils/evidenceMatches'
import { AudioRecorderButton } from '../realtime/AudioRecorderButton'
import { RealtimeTranscript } from '../transcript/RealtimeTranscript'
import { ErrorState } from '../ui/ErrorState'
import type { useAudioRecorder } from '../../hooks/useAudioRecorder'
import type { RealtimeLanguage, RealtimeSpeakerMode, TranscriptSegment } from '../../hooks/useRealtimeMeetingStream'
import type { MicSensitivityMode } from '../../hooks/useVoiceActivityDetection'
import type { AiAnalysis } from '../../types'
import {
  REALTIME_FOCUS_MEET_CAPTURE_KEY,
  type RecordingSource,
  isBrowserTabRecordingSource,
} from '../../constants/recordingSource'
import type { DomainMode } from '../../constants/domainMode'
import DomainModeSelector from '../ui/DomainModeSelector'
import { RecordingSourceSelector } from '../realtime/RecordingSourceSelector'
import { DualStreamQuotaInfoBanner } from '../ui/DualStreamQuotaInfoBanner'

const REALTIME_LANGUAGE_OPTIONS: Array<{ value: RealtimeLanguage; label: string }> = [
  { value: 'vi', label: 'Tiếng Việt' },
  { value: 'en', label: 'English' },
  { value: 'multi', label: 'Việt + Anh' },
]

const REALTIME_SPEAKER_MODE_OPTIONS: Array<{ value: RealtimeSpeakerMode; label: string }> = [
  { value: 'single', label: 'Một người nói' },
  { value: 'multiple', label: 'Nhiều người nói' },
]

const REALTIME_MIC_SENSITIVITY_OPTIONS: Array<{ value: MicSensitivityMode; label: string }> = [
  { value: 'low', label: 'Thấp' },
  { value: 'normal', label: 'Bình thường' },
  { value: 'high', label: 'Cao' },
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
  selectedDomainMode: DomainMode
  onDomainModeChange: (mode: DomainMode) => void
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
  onChunkReady?: (chunk: Blob, sessionId: number) => void | Promise<void>
  onRecordingComplete?: (fullAudio: Blob, sessionId: number) => void
  onStopRequested?: () => void
  gracefulStopRef?: MutableRefObject<(() => Promise<void>) | null>
  liveError: string | null
  liveErrorCode?: string | null
  onNavigateBilling?: () => void
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
  onUpgradePlan?: () => void
  dualStreamActive?: boolean
  dualStreamBackendEnabled?: boolean
  sttQuotaPercent?: number
}

export const resolveRealtimeLifecycleBadge = (
  liveLifecycleState: LiveLifecycleState,
  liveAnalysisStatus: 'idle' | 'polling' | 'completed' | 'pending' | 'failed',
): { label: string; tone: 'listening' | 'paused' | 'resumed' | 'stopped' | 'analyzing' | 'idle' | 'error' } => {
  if (liveLifecycleState === 'error') {
    return { label: 'Lỗi', tone: 'error' }
  }

  if (liveLifecycleState === 'silent_paused') {
    return { label: 'Tạm dừng', tone: 'paused' }
  }

  if (liveLifecycleState === 'listening_resumed') {
    return { label: 'Tiếp tục nghe', tone: 'resumed' }
  }

  if (liveLifecycleState === 'recording') {
    return { label: 'Đang ghi âm', tone: 'listening' }
  }

  if (liveLifecycleState === 'finalizing_recording') {
    return { label: 'Đang hoàn tất ghi âm', tone: 'stopped' }
  }

  if (liveLifecycleState === 'stopped') {
    if (liveAnalysisStatus === 'polling') {
      return { label: 'Đang phân tích', tone: 'analyzing' }
    }
    return { label: 'Đã dừng', tone: 'stopped' }
  }

  if (liveLifecycleState === 'no_transcript_after_finalize' || liveLifecycleState === 'stopped_no_analysis') {
    return { label: 'Không có transcript', tone: 'stopped' }
  }

  if (liveLifecycleState === 'failed_audio_capture') {
    return { label: 'Không thu được âm thanh', tone: 'error' }
  }

  if (liveLifecycleState === 'stopping') {
    return { label: 'Đang dừng', tone: 'stopped' }
  }

  if (liveLifecycleState === 'connecting') {
    return { label: 'Đang kết nối', tone: 'idle' }
  }

  return { label: 'Sẵn sàng', tone: 'idle' }
}

export default function RealtimeDashboardScene({
  liveStatusMessage,
  connectionView,
  selectedRealtimeLanguage,
  selectedDomainMode,
  onDomainModeChange,
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
  liveErrorCode,
  onNavigateBilling,
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
  onUpgradePlan,
  dualStreamActive = false,
  dualStreamBackendEnabled,
  sttQuotaPercent,
}: RealtimeDashboardSceneProps) {
  const [highlightMeetCapture, setHighlightMeetCapture] = useState(false)
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(liveLifecycleState === 'recording')

  useEffect(() => {
    try {
      if (sessionStorage.getItem(REALTIME_FOCUS_MEET_CAPTURE_KEY) !== '1') {
        return
      }
      sessionStorage.removeItem(REALTIME_FOCUS_MEET_CAPTURE_KEY)
      setHighlightMeetCapture(true)
      window.requestAnimationFrame(() => {
        document.querySelector('[data-testid="recording-source-selector"]')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
      const timeoutId = window.setTimeout(() => setHighlightMeetCapture(false), 5000)
      return () => window.clearTimeout(timeoutId)
    } catch {
      return undefined
    }
  }, [])

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
    ? 'Phân tích chưa sẵn sàng. Hãy thử lại khi bản ghi đã hoàn tất.'
    : liveAnalysisStatus === 'failed'
      ? (liveAnalysisMetadata?.transcriptSaved || liveAnalysisMetadata?.retryable
        ? 'Transcript đã lưu. Phân tích AI tạm thời chưa sẵn sàng.'
        : 'Phân tích AI tạm thời thất bại. Có thể thử lại.')
      : 'Chưa có phân tích realtime.'
  const liveEvidenceMatches = useMemo(
    () => collectEvidenceMatchesFromAnalysis(
      (liveAnalysisMetadata ?? liveAnalysis) as Record<string, unknown> | null,
    ),
    [liveAnalysisMetadata, liveAnalysis],
  )
  const isRecordingActive =
    liveLifecycleState === 'connecting'
    || liveLifecycleState === 'recording'
    || liveLifecycleState === 'silent_paused'
    || liveLifecycleState === 'listening_resumed'
    || liveLifecycleState === 'stopping'
    || liveLifecycleState === 'finalizing_recording'
  const isTabAudioSource = isBrowserTabRecordingSource(selectedRecordingSource)
  const isTabOnlySource = selectedRecordingSource === 'browser_tab'
  const micSensitivityDisabled =
    liveLifecycleState === 'stopping'
    || (isTabOnlySource && isRecordingActive)
  const micSensitivityHelper = isTabOnlySource
    ? (isRecordingActive
      ? 'Không áp dụng khi chỉ ghi âm thanh tab đang chạy.'
      : 'Chỉ áp dụng khi ghi microphone hoặc Tab + Microphone.')
    : null
  const noiseSuppressionDisabled = isRecordingActive || !noiseSuppressionSupported || isTabOnlySource
  const noiseSuppressionHelper = isTabOnlySource
    ? 'Không áp dụng khi chỉ ghi âm thanh tab.'
    : isTabAudioSource
    ? 'Áp dụng cho microphone khi chọn Tab trình duyệt + Microphone.'
    : !noiseSuppressionSupported
    ? 'Trình duyệt không hỗ trợ tùy chọn này, ghi âm vẫn hoạt động.'
    : isRecordingActive
      ? 'Áp dụng ở lần ghi tiếp theo.'
      : 'Bật để giảm tiếng quạt, bàn phím, tạp âm nền. Tắt nếu giọng bị méo hoặc mất âm.'

  return (
    <div className="dashboard-page bg-gray-light">
      <section className="realtime-panel realtime-panel--dashboard">
        <div className="realtime-hero">
          <div className="realtime-panel__header">
            <div>
              <h2 className="realtime-panel__title">Ghi âm trực tiếp</h2>
              <div className="realtime-panel__status-row">
                <span className={`realtime-status-badge realtime-status-badge--${lifecycleBadge.tone}`}>
                  {lifecycleBadge.label}
                </span>
                <span className="realtime-connection-chip meta-pill" data-testid="realtime-connection-status">
                  {connectionView.title || 'Chưa kết nối'}
                </span>
                <span className="realtime-transcript-chip meta-pill" data-testid="realtime-transcript-status">
                  {liveTranscriptSegments.length > 0
                    ? `${liveTranscriptSegments.length} đoạn bản ghi`
                    : 'Chưa có bản ghi trực tiếp'}
                </span>
                <p className="realtime-panel__status">
                  {liveStatusMessage || connectionView.detail || 'Sẵn sàng tạo meeting và bắt đầu ghi âm'}
                </p>
              </div>
            </div>
            {liveMeetingId && (
              <span className="realtime-panel__meeting-badge">Cuộc họp #{liveMeetingId}</span>
            )}
          </div>

          <div className="realtime-workflow-grid">
            <section className="ui-section ui-section--subtle realtime-stage realtime-stage--prepare">
              <div>
                <p className="ui-section__eyebrow">1. Chuẩn bị ghi</p>
                <h3 className="ui-section__title">Nguồn âm thanh và ngữ cảnh</h3>
                <p className="ui-section__description">
                  Chọn nguồn ghi, ngôn ngữ và lĩnh vực trước khi bắt đầu.
                </p>
              </div>
              <div className="realtime-panel__settings">
                {highlightMeetCapture && (
                  <p className="realtime-meet-capture-banner" data-testid="realtime-meet-capture-banner">
                    Đã chọn ghi âm tab trình duyệt. Mở tab cần ghi, rồi bấm nút ghi âm bên dưới.
                  </p>
                )}
                <div className={highlightMeetCapture ? 'recording-source-selector-wrap--highlight' : undefined}>
                  <RecordingSourceSelector
                    value={selectedRecordingSource}
                    disabled={isRecordingSourceSelectorDisabled}
                    showDualStreamQuotaNote={dualStreamActive}
                    onChange={onRecordingSourceChange}
                  />
                </div>
                <div className="ui-field-grid">
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
                  <DomainModeSelector
                    id="realtime-domain-mode"
                    value={selectedDomainMode}
                    onChange={onDomainModeChange}
                    disabled={isRealtimeLanguageSelectorDisabled}
                    testId="realtime-domain-mode-select"
                    compact
                  />
                </div>
                <button
                  type="button"
                  className="btn btn--secondary"
                  aria-expanded={advancedSettingsOpen}
                  onClick={() => setAdvancedSettingsOpen((current) => !current)}
                  data-testid="realtime-advanced-settings-toggle"
                >
                  {advancedSettingsOpen ? 'Ẩn tùy chỉnh nâng cao' : 'Mở tùy chỉnh nâng cao'}
                </button>
                {advancedSettingsOpen && (
                  <div className="realtime-advanced-settings" data-testid="realtime-advanced-settings">
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
                        disabled={micSensitivityDisabled}
                      >
                        {REALTIME_MIC_SENSITIVITY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      {micSensitivityHelper && (
                        <span className="realtime-panel__hint">{micSensitivityHelper}</span>
                      )}
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
                          <span>{noiseSuppressionEnabled ? 'Bật' : 'Tắt'}</span>
                        </span>
                        <span className="realtime-panel__hint">{noiseSuppressionHelper}</span>
                      </label>
                    )}
                  </div>
                )}
              </div>
            </section>

            <section className="ui-section ui-section--subtle realtime-stage realtime-stage--recording">
              <div>
                <p className="ui-section__eyebrow">2. Đang ghi</p>
                <h3 className="ui-section__title">Điều khiển phiên ghi</h3>
                <p className="ui-section__description">
                  Bắt đầu, dừng và theo dõi trạng thái realtime tại một nơi.
                </p>
              </div>
              <div className="realtime-panel__recorder-wrap">
                {dualStreamActive && dualStreamBackendEnabled === false && (
                  <div className="warning-banner" role="alert">
                    Chế độ tách riêng âm thanh tab và micro chưa sẵn sàng. Phiên này sẽ ghi bằng một luồng âm thanh.
                  </div>
                )}
                <DualStreamQuotaInfoBanner
                  visible={dualStreamActive && selectedRecordingSource === 'browser_tab_with_mic'}
                  isRecording={liveLifecycleState === 'recording'}
                  sttPercent={sttQuotaPercent}
                  onNavigateBilling={onNavigateBilling}
                />
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
            </section>
          </div>
        </div>

        {liveError && (
          <ErrorState
            message={liveError}
            errorCode={liveErrorCode ?? undefined}
            title="Lỗi realtime"
            onCtaClick={onNavigateBilling}
          />
        )}
        {livePartialWarning && <div className="warning-banner">{livePartialWarning}</div>}

        {showJoinOtherMeeting && (
          <div className="join-meeting-panel">
            <strong>Tham gia cuộc họp khác</strong>
            <input
              type="number"
              placeholder="ID cuộc họp"
              value={joinMeetingIdInput}
              onChange={(event) => onJoinMeetingIdChange(event.target.value)}
            />
            <button type="button" onClick={onJoinMeeting} disabled={!joinMeetingIdInput.trim()}>
              Tham gia
            </button>
          </div>
        )}

        <section className="ui-section realtime-stage realtime-stage--live">
          <div>
            <p className="ui-section__eyebrow">Bản ghi trực tiếp</p>
            <h3 className="ui-section__title">Nội dung đang ghi</h3>
          </div>
        <div className="realtime-panel__grid realtime-panel__grid--transcript">
          <RealtimeTranscript
            segments={liveTranscriptSegments}
            isPaused={liveLifecycleState === 'silent_paused'}
            highlightKeywords={liveTranscriptKeywords}
            emptyMessage={isNoTranscriptFinalized ? 'Chưa có bản ghi' : undefined}
            maxHeight="620px"
            domainMode={liveAnalysis?.domainMode}
          />

          <aside className="realtime-panel__aside">
            <div className="status-card status-card--live">
              <div className="status-card__label">Kết nối</div>
              <div className="status-card__value">{connectionViewForAside.title}</div>
              <div className="status-card__detail">{connectionViewForAside.detail}</div>
            </div>
            <div className="status-card">
              <div className="status-card__label">Từ khóa</div>
              <div className="status-card__value">{realtimeKeywordCount}</div>
            </div>
            <div className="status-card">
              <div className="status-card__label">Người dùng</div>
              <div className="status-card__value">{currentUserId || 'Chưa rõ'}</div>
            </div>
          </aside>
        </div>
        </section>

        {showLiveAnalysis && (
          <section className="ui-section realtime-analysis-section">
            <div>
              <p className="ui-section__eyebrow">3. Sau khi ghi</p>
              <h3 className="ui-section__title">Phân tích realtime</h3>
            </div>
            <AnalysisStatusPanel
              metadata={liveAnalysisMetadata ?? liveAnalysis}
              evidenceMatches={liveEvidenceMatches}
              busy={liveAnalysisStatus === 'polling'}
              error={liveAnalysisError}
              onReanalyze={onLiveAnalysisRetry}
              onUpgradePlan={onUpgradePlan}
            />
            <AnalysisPanel
              title="Phân tích realtime"
              analysis={liveAnalysis}
              status={liveAnalysisPanelStatus}
              loadingMessage="Đang tạo phân tích…"
              errorMessage={liveAnalysisStatus === 'failed' ? liveAnalysisError : null}
              emptyMessage={liveAnalysisEmptyMessage}
              summaryFallback="(đang chờ phân tích)"
              testId="e2e-live-analysis"
            />
          </section>
        )}
      </section>
    </div>
  )
}
