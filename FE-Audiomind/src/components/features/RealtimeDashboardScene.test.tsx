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
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    abortRecording: vi.fn(),
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    duration: 0,
    getCurrentRms: vi.fn(),
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
          liveLifecycleState="stopped"
          onRealtimeLanguageChange={vi.fn()}
          onRealtimeSpeakerModeChange={vi.fn()}
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
})
