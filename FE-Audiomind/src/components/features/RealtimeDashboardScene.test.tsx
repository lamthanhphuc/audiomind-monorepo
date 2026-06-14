import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UseAudioRecorderReturn } from '../../hooks/useAudioRecorder'
import type { AiAnalysis } from '../../types'
import RealtimeDashboardScene from './RealtimeDashboardScene'

describe('RealtimeDashboardScene', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  const recorder: UseAudioRecorderReturn = {
    state: 'stopped',
    errorMessage: null,
    audioChunks: [],
    recordingSessionId: 1,
    startRecording: vi.fn().mockResolvedValue(1),
    stopRecording: vi.fn(),
    abortRecording: vi.fn(),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    duration: 0,
    getCurrentRms: vi.fn(),
    getRollingChunks: vi.fn(() => []),
  }

  const analysis: AiAnalysis = {
    meetingId: 42,
    meeting_id: 42,
    status: 'COMPLETED',
    analysisStatus: 'COMPLETED',
    summary: 'Realtime analysis is ready',
    meetingSummary: 'Realtime analysis is ready',
    keywords: ['Gemini'],
    technicalTerms: [],
    painPoints: [],
    actionItems: ['Review action items'],
    domainMode: 'it',
  }

  it('renders ready analysis when liveAnalysis exists', () => {
    act(() => {
      root.render(
        <RealtimeDashboardScene
          liveStatusMessage="Saved"
          connectionView={{
            title: 'Complete',
            detail: 'Transcript saved',
            closeReason: null,
            closeReasonIsError: false,
          }}
          selectedRealtimeLanguage="vi"
          selectedRealtimeSpeakerMode="single"
          selectedMicSensitivity="normal"
          noiseSuppressionEnabled
          noiseSuppressionToggleEnabled
          noiseSuppressionSupported
          liveLifecycleState="stopped"
          onRealtimeLanguageChange={vi.fn()}
          onRealtimeSpeakerModeChange={vi.fn()}
          onMicSensitivityChange={vi.fn()}
          onNoiseSuppressionChange={vi.fn()}
          isRealtimeLanguageSelectorDisabled={false}
          isRealtimeSpeakerModeSelectorDisabled={false}
          liveMeetingId={42}
          audioRecorder={recorder}
          onBeforeStartRecording={vi.fn()}
          onChunkReady={vi.fn()}
          onRecordingComplete={vi.fn()}
          liveError={null}
          livePartialWarning={null}
          showJoinOtherMeeting={false}
          joinMeetingIdInput=""
          onJoinMeetingIdChange={vi.fn()}
          onJoinMeeting={vi.fn()}
          liveTranscriptSegments={[]}
          liveTranscriptKeywords={[]}
          realtimeKeywordCount={0}
          currentUserId="7"
          connectionViewForAside={{
            title: 'Complete',
            detail: 'Transcript saved',
            closeReason: null,
            closeReasonIsError: false,
          }}
          liveAnalysis={analysis}
          liveAnalysisMetadata={analysis}
          liveAnalysisStatus="completed"
          liveAnalysisError={null}
          showLiveAnalysis
          onLiveAnalysisRetry={vi.fn()}
        />,
      )
    })

    expect(container.querySelector('[data-testid="e2e-live-analysis-summary"]')?.textContent)
      .toContain('Realtime analysis is ready')
    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent)
      .toBe('COMPLETED')
  })

  it('renders finalized no-transcript state without analysis loading', () => {
    const metadata: AiAnalysis = {
      meetingId: 42,
      meeting_id: 42,
      status: 'NO_ANALYSIS',
      analysisStatus: 'NO_ANALYSIS',
      errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
      transcriptRows: 0,
      finalized: true,
      summary: '',
      keywords: [],
      technicalTerms: [],
      painPoints: [],
      actionItems: [],
      domainMode: 'it',
    }

    act(() => {
      root.render(
        <RealtimeDashboardScene
          liveStatusMessage="Chưa có transcript"
          connectionView={{
            title: 'Chưa có transcript',
            detail: 'Không có nội dung để phân tích',
            closeReason: null,
            closeReasonIsError: false,
          }}
          selectedRealtimeLanguage="vi"
          selectedRealtimeSpeakerMode="single"
          selectedMicSensitivity="normal"
          noiseSuppressionEnabled
          noiseSuppressionToggleEnabled
          noiseSuppressionSupported
          liveLifecycleState="stopped_no_analysis"
          onRealtimeLanguageChange={vi.fn()}
          onRealtimeSpeakerModeChange={vi.fn()}
          onMicSensitivityChange={vi.fn()}
          onNoiseSuppressionChange={vi.fn()}
          isRealtimeLanguageSelectorDisabled={false}
          isRealtimeSpeakerModeSelectorDisabled={false}
          liveMeetingId={42}
          audioRecorder={recorder}
          onBeforeStartRecording={vi.fn()}
          onChunkReady={vi.fn()}
          onRecordingComplete={vi.fn()}
          liveError={null}
          livePartialWarning="Chưa có transcript"
          showJoinOtherMeeting={false}
          joinMeetingIdInput=""
          onJoinMeetingIdChange={vi.fn()}
          onJoinMeeting={vi.fn()}
          liveTranscriptSegments={[]}
          liveTranscriptKeywords={[]}
          realtimeKeywordCount={0}
          currentUserId="7"
          connectionViewForAside={{
            title: 'Chưa có transcript',
            detail: 'Không có nội dung để phân tích',
            closeReason: null,
            closeReasonIsError: false,
          }}
          liveAnalysis={null}
          liveAnalysisMetadata={metadata}
          liveAnalysisStatus="pending"
          liveAnalysisError={null}
          showLiveAnalysis
          onLiveAnalysisRetry={vi.fn()}
        />,
      )
    })

    expect(container.textContent).toContain('Chưa có transcript')
    expect(container.textContent).toContain('Không có nội dung để phân tích')
    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent)
      .toBe('NO_ANALYSIS')
    expect(container.textContent).not.toContain('Analysis is being generated')
    expect(container.textContent).not.toContain('Đã lưu transcript')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="analysis-reanalyze-button"]')?.disabled)
      .toBe(true)
  })

  it('renders mic sensitivity and noise suppression controls independently', () => {
    const onSensitivityChange = vi.fn()
    const onNoiseSuppressionChange = vi.fn()

    act(() => {
      root.render(
        <RealtimeDashboardScene
          liveStatusMessage="Ready"
          connectionView={{
            title: 'Ready',
            detail: 'Ready',
            closeReason: null,
            closeReasonIsError: false,
          }}
          selectedRealtimeLanguage="vi"
          selectedRealtimeSpeakerMode="single"
          selectedMicSensitivity="high"
          noiseSuppressionEnabled={false}
          noiseSuppressionToggleEnabled
          noiseSuppressionSupported
          liveLifecycleState="recording"
          onRealtimeLanguageChange={vi.fn()}
          onRealtimeSpeakerModeChange={vi.fn()}
          onMicSensitivityChange={onSensitivityChange}
          onNoiseSuppressionChange={onNoiseSuppressionChange}
          isRealtimeLanguageSelectorDisabled
          isRealtimeSpeakerModeSelectorDisabled
          liveMeetingId={42}
          audioRecorder={{ ...recorder, state: 'recording' }}
          onBeforeStartRecording={vi.fn()}
          onChunkReady={vi.fn()}
          onRecordingComplete={vi.fn()}
          liveError={null}
          livePartialWarning={null}
          showJoinOtherMeeting={false}
          joinMeetingIdInput=""
          onJoinMeetingIdChange={vi.fn()}
          onJoinMeeting={vi.fn()}
          liveTranscriptSegments={[]}
          liveTranscriptKeywords={[]}
          realtimeKeywordCount={0}
          currentUserId="7"
          connectionViewForAside={{
            title: 'Ready',
            detail: 'Ready',
            closeReason: null,
            closeReasonIsError: false,
          }}
          liveAnalysis={null}
          liveAnalysisMetadata={null}
          liveAnalysisStatus="idle"
          liveAnalysisError={null}
          showLiveAnalysis={false}
          onLiveAnalysisRetry={vi.fn()}
        />,
      )
    })

    const sensitivitySelect = Array.from(container.querySelectorAll('select'))
      .find((select) => select.value === 'high')
    const noiseToggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')

    expect(sensitivitySelect).toBeDefined()
    expect(noiseToggle?.checked).toBe(false)
    expect(noiseToggle?.disabled).toBe(true)
    expect(container.textContent).toContain('Áp dụng ở lần ghi tiếp theo.')

    act(() => {
      sensitivitySelect?.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onNoiseSuppressionChange).not.toHaveBeenCalled()
  })
})
