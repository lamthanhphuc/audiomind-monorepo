import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UseAudioRecorderReturn } from '../../hooks/useAudioRecorder'
import type { AiAnalysis } from '../../types'
import RealtimeDashboardScene, { resolveRealtimeLifecycleBadge } from './RealtimeDashboardScene'

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
    stopRecordingGraceful: vi.fn().mockResolvedValue({
      fullBlob: new Blob(),
      sessionId: 1,
      collectedChunkCount: 0,
      postStopChunkCount: 0,
      chunks: [],
    }),
    cleanupRecordingResources: vi.fn(),
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

  const baseProps = {
    liveStatusMessage: 'Ready',
    connectionView: {
      title: 'Ready',
      detail: 'Ready',
      closeReason: null,
      closeReasonIsError: false,
    },
    selectedRealtimeLanguage: 'vi' as const,
    selectedDomainMode: 'it' as const,
    onDomainModeChange: vi.fn(),
    selectedRealtimeSpeakerMode: 'single' as const,
    selectedMicSensitivity: 'normal' as const,
    selectedRecordingSource: 'microphone' as const,
    noiseSuppressionEnabled: true,
    noiseSuppressionToggleEnabled: true,
    noiseSuppressionSupported: true,
    liveLifecycleState: 'stopped' as const,
    onRealtimeLanguageChange: vi.fn(),
    onRealtimeSpeakerModeChange: vi.fn(),
    onMicSensitivityChange: vi.fn(),
    onRecordingSourceChange: vi.fn(),
    onNoiseSuppressionChange: vi.fn(),
    isRealtimeLanguageSelectorDisabled: false,
    isRealtimeSpeakerModeSelectorDisabled: false,
    isRecordingSourceSelectorDisabled: false,
    liveMeetingId: 42,
    audioRecorder: recorder,
    onBeforeStartRecording: vi.fn(),
    onChunkReady: vi.fn(),
    onRecordingComplete: vi.fn(),
    liveError: null,
    livePartialWarning: null,
    showJoinOtherMeeting: false,
    joinMeetingIdInput: '',
    onJoinMeetingIdChange: vi.fn(),
    onJoinMeeting: vi.fn(),
    liveTranscriptSegments: [],
    liveTranscriptKeywords: [],
    realtimeKeywordCount: 0,
    currentUserId: '7',
    connectionViewForAside: {
      title: 'Ready',
      detail: 'Ready',
      closeReason: null,
      closeReasonIsError: false,
    },
    liveAnalysis: null,
    liveAnalysisMetadata: null,
    liveAnalysisStatus: 'idle' as const,
    liveAnalysisError: null,
    showLiveAnalysis: false,
    onLiveAnalysisRetry: vi.fn(),
  }

  it('renders ready analysis when liveAnalysis exists', () => {
    act(() => {
      root.render(
        <RealtimeDashboardScene
          {...baseProps}
          liveStatusMessage="Saved"
          connectionView={{
            title: 'Complete',
            detail: 'Transcript saved',
            closeReason: null,
            closeReasonIsError: false,
          }}
          liveLifecycleState="stopped"
          connectionViewForAside={{
            title: 'Complete',
            detail: 'Transcript saved',
            closeReason: null,
            closeReasonIsError: false,
          }}
          liveAnalysis={analysis}
          liveAnalysisMetadata={analysis}
          liveAnalysisStatus="completed"
          showLiveAnalysis
        />,
      )
    })

    expect(container.querySelector('[data-testid="e2e-live-analysis-summary"]')?.textContent)
      .toContain('Realtime analysis is ready')
    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent)
      .toBe('Hoàn tất')
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
          {...baseProps}
          liveStatusMessage="Chưa có transcript"
          connectionView={{
            title: 'Chưa có transcript',
            detail: 'Không có nội dung để phân tích',
            closeReason: null,
            closeReasonIsError: false,
          }}
          liveLifecycleState="stopped_no_analysis"
          livePartialWarning="Chưa có transcript"
          connectionViewForAside={{
            title: 'Chưa có transcript',
            detail: 'Không có nội dung để phân tích',
            closeReason: null,
            closeReasonIsError: false,
          }}
          liveAnalysisMetadata={metadata}
          liveAnalysisStatus="pending"
          showLiveAnalysis
        />,
      )
    })

    expect(container.textContent).toContain('Chưa có transcript')
    expect(container.textContent).toContain('Không có nội dung để phân tích')
    expect(container.querySelector('[data-testid="analysis-status-badge"]')?.textContent)
      .toBe('Chưa phân tích')
    expect(container.textContent).not.toContain('Đang tạo phân tích')
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
          {...baseProps}
          selectedMicSensitivity="high"
          noiseSuppressionEnabled={false}
          liveLifecycleState="recording"
          isRealtimeLanguageSelectorDisabled
          isRealtimeSpeakerModeSelectorDisabled
          isRecordingSourceSelectorDisabled
          audioRecorder={{ ...recorder, state: 'recording' }}
          onMicSensitivityChange={onSensitivityChange}
          onNoiseSuppressionChange={onNoiseSuppressionChange}
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

  it('renders recording source selector and tab capture guidance for tab audio', () => {
    const onRecordingSourceChange = vi.fn()

    act(() => {
      root.render(
        <RealtimeDashboardScene
          {...baseProps}
          selectedRecordingSource="browser_tab"
          onRecordingSourceChange={onRecordingSourceChange}
        />,
      )
    })

    expect(container.querySelector('[data-testid="recording-source-selector"]')).not.toBeNull()
    expect(container.textContent).toContain('Nguồn ghi âm')
    expect(container.textContent).toContain('Ghi âm tab trình duyệt')
    expect(container.textContent).toContain('Hướng dẫn ghi âm tab trình duyệt')
    expect(container.textContent).toContain('Chia sẻ âm thanh tab')

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="recording-source-option-browser_tab_with_mic"]')?.click()
    })
    expect(onRecordingSourceChange).toHaveBeenCalledWith('browser_tab_with_mic')
  })

  it('shows dual-stream quota banner when dualStreamActive is enabled', () => {
    act(() => {
      root.render(
        <RealtimeDashboardScene
          {...baseProps}
          selectedRecordingSource="browser_tab_with_mic"
          dualStreamActive
        />,
      )
    })

    expect(container.querySelector('[data-testid="dual-stream-quota-info"]')).not.toBeNull()
    expect(container.textContent).toMatch(/hai luồng|gấp đôi quota STT/i)
  })

  it('shows finalizing_recording lifecycle badge while recorder tail is flushing', () => {
    const badge = resolveRealtimeLifecycleBadge('finalizing_recording', 'idle')
    expect(badge.label).toBe('Đang hoàn tất ghi âm')
    expect(badge.tone).toBe('stopped')
  })

  it('renders finalizing_recording badge in the dashboard header', () => {
    act(() => {
      root.render(
        <RealtimeDashboardScene
          {...baseProps}
          liveLifecycleState="finalizing_recording"
          audioRecorder={{ ...recorder, state: 'stopped' }}
        />,
      )
    })

    expect(container.textContent).toContain('Đang hoàn tất ghi âm')
  })

  it('hides noise suppression toggle for tab-only capture', () => {
    act(() => {
      root.render(
        <RealtimeDashboardScene
          {...baseProps}
          selectedRecordingSource="browser_tab"
          noiseSuppressionEnabled={false}
        />,
      )
    })

    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
  })
})

