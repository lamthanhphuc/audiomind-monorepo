import { createRoot } from 'react-dom/client'
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useRealtimeLifecycleEffects,
  type RealtimeLifecycleEffectsInput,
} from './useRealtimeLifecycleEffects'
import { useTerminalAudioCaptureCleanup } from './useTerminalAudioCaptureCleanup'
import {
  useRealtimeMeetingStream,
  type RealtimeSessionToken,
} from '../hooks/useRealtimeMeetingStream'

const originalActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT

const createToken = (
  meetingId: number,
  recordingSessionId: number,
  attemptId: number,
  connectionSeq = 0,
): RealtimeSessionToken => ({
  meetingId,
  recordingSessionId,
  attemptId,
  connectionSeq,
})

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  readonly url: string
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({})
  })

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.({})
  }

  receive(payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

const originalWebSocket = globalThis.WebSocket

type LifecycleEffectsHarnessInput = Omit<RealtimeLifecycleEffectsInput, 'runTerminalAudioCaptureCleanupRef'>

const useLifecycleEffectsTestHarness = (input: LifecycleEffectsHarnessInput) => {
  const { runTerminalAudioCaptureCleanupRef } = useTerminalAudioCaptureCleanup({
    audioRecorder: input.audioRecorder,
    realtimeStream: input.realtimeStream,
    activeRealtimeSessionTokenRef: input.activeRealtimeSessionTokenRef,
    liveMeetingIdRef: input.liveMeetingIdRef,
    liveAnalysisAbortControllerRef: input.liveAnalysisAbortControllerRef,
    analysisPollRunIdRef: input.analysisPollRunIdRef,
    setLiveLifecycleState: input.setLiveLifecycleState,
    setLiveError: input.setLiveError,
    setLiveAnalysis: input.setLiveAnalysis,
    setLiveAnalysisMetadata: input.setLiveAnalysisMetadata,
    setLiveAnalysisStatus: input.setLiveAnalysisStatus,
    setLiveAnalysisError: input.setLiveAnalysisError,
    setLivePartialWarning: input.setLivePartialWarning,
    setLiveStatusMessage: input.setLiveStatusMessage,
  })
  useRealtimeLifecycleEffects({
    ...input,
    runTerminalAudioCaptureCleanupRef,
  })
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

type TabFailureHarnessControls = {
  triggerTabFailure: (message?: string) => void
  bumpRerender: () => void
  onTabCaptureFailureRef: { current: ((message: string, reason: 'track' | 'stall') => void) | undefined }
}

describe('useRealtimeLifecycleEffects FAILED_AUDIO_CAPTURE cleanup', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    vi.restoreAllMocks()
  })

  it('runs FAILED_AUDIO_CAPTURE cleanup once across rerenders with new object identities', async () => {
    const token = createToken(88, 1, 1)
    const abortRecording = vi.fn()
    const disconnect = vi.fn()
    const clearQueuedAudio = vi.fn()
    const setLiveAnalysisMetadata = vi.fn()
    const setLiveError = vi.fn()
    const setLiveLifecycleState = vi.fn()
    const tokenRef = { current: token as RealtimeSessionToken | null }
    const meetingIdRef = { current: 88 as number | null }
    let bumpRerender: (() => void) | null = null

    function Harness() {
      const [, setTick] = useState(0)
      bumpRerender = () => setTick((value) => value + 1)

      const audioRecorder = {
        state: 'recording' as const,
        abortRecording,
        startRecording: vi.fn(),
      }
      const realtimeStream = {
        status: {
          state: 'FAILED_AUDIO_CAPTURE',
          status: 'FAILED_AUDIO_CAPTURE',
          errorCode: 'REALTIME_UNSUPPORTED_RECORDER_FORMAT',
        },
        isAuthenticated: true,
        clearQueuedAudio,
        disconnect,
      }

      useLifecycleEffectsTestHarness({
        audioRecorder,
        realtimeStream,
        voiceActivity: { state: 'idle' },
        dualStreamActive: false,
        selectedRecordingSource: 'mic',
        selectedRecordingSourceRef: { current: 'mic' },
        selectedRealtimeLanguage: 'vi',
        selectedRealtimeSpeakerMode: 'single',
        selectedMicSensitivity: 'normal',
        noiseSuppressionEnabled: false,
        noiseSuppressionSupported: false,
        activeRealtimeSessionToken: token,
        activeRealtimeSessionTokenRef: tokenRef,
        liveLifecycleState: 'listening',
        liveMeetingIdRef: meetingIdRef,
        liveAnalysisAbortControllerRef: { current: null },
        analysisPollRunIdRef: { current: 0 },
        resetRecoveryInProgressRef: { current: false },
        restartAfterReconnectRef: { current: false },
        tabTrackEndedFinalizeRef: { current: false },
        gracefulStopRef: { current: null },
        lastVoiceActivityStateRef: { current: null },
        onTabAudioTrackEndedRef: { current: undefined },
        onTabCaptureFailureRef: { current: undefined },
        onTabPipelineStalledRef: { current: undefined },
        setLiveLifecycleState,
        setLiveError,
        setLiveStatusMessage: vi.fn(),
        setLivePartialWarning: vi.fn(),
        setLiveAnalysis: vi.fn(),
        setLiveAnalysisMetadata,
        setLiveAnalysisStatus: vi.fn(),
        setLiveAnalysisError: vi.fn(),
      } as unknown as RealtimeLifecycleEffectsInput)
      return null
    }

    act(() => {
      root.render(<Harness />)
    })
    act(() => {
      bumpRerender?.()
    })
    act(() => {
      bumpRerender?.()
    })

    expect(abortRecording).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith(token, { reason: 'audio_capture_failure' })
    expect(clearQueuedAudio).toHaveBeenCalledTimes(1)
    expect(setLiveAnalysisMetadata).toHaveBeenCalledTimes(1)
    expect(setLiveError).toHaveBeenCalledTimes(1)
    expect(
      setLiveLifecycleState.mock.calls.filter(([state]) => state === 'failed_audio_capture'),
    ).toHaveLength(1)
  })

  it('allows a new FAILED_AUDIO_CAPTURE cleanup for a new session attempt', async () => {
    const abortRecording = vi.fn()
    const disconnect = vi.fn()
    const clearQueuedAudio = vi.fn()
    const setLiveAnalysisMetadata = vi.fn()
    const tokenRef = { current: null as RealtimeSessionToken | null }
    const meetingIdRef = { current: 88 as number | null }

    const renderHarness = (token: RealtimeSessionToken) => {
      tokenRef.current = token
      function Harness() {
        useLifecycleEffectsTestHarness({
          audioRecorder: {
            state: 'recording',
            abortRecording,
            startRecording: vi.fn(),
          },
          realtimeStream: {
            status: {
              state: 'FAILED_AUDIO_CAPTURE',
              status: 'FAILED_AUDIO_CAPTURE',
              errorCode: 'FAILED_AUDIO_CAPTURE',
            },
            isAuthenticated: false,
            clearQueuedAudio,
            disconnect,
          },
          voiceActivity: { state: 'idle' },
          dualStreamActive: false,
          selectedRecordingSource: 'mic',
          selectedRecordingSourceRef: { current: 'mic' },
          selectedRealtimeLanguage: 'vi',
          selectedRealtimeSpeakerMode: 'single',
          selectedMicSensitivity: 'normal',
          noiseSuppressionEnabled: false,
          noiseSuppressionSupported: false,
          activeRealtimeSessionToken: token,
          activeRealtimeSessionTokenRef: tokenRef,
          liveLifecycleState: 'listening',
          liveMeetingIdRef: meetingIdRef,
          liveAnalysisAbortControllerRef: { current: null },
          analysisPollRunIdRef: { current: 0 },
          resetRecoveryInProgressRef: { current: false },
          restartAfterReconnectRef: { current: false },
          tabTrackEndedFinalizeRef: { current: false },
          gracefulStopRef: { current: null },
          lastVoiceActivityStateRef: { current: null },
          onTabAudioTrackEndedRef: { current: undefined },
          onTabCaptureFailureRef: { current: undefined },
          onTabPipelineStalledRef: { current: undefined },
          setLiveLifecycleState: vi.fn(),
          setLiveError: vi.fn(),
          setLiveStatusMessage: vi.fn(),
          setLivePartialWarning: vi.fn(),
          setLiveAnalysis: vi.fn(),
          setLiveAnalysisMetadata,
          setLiveAnalysisStatus: vi.fn(),
          setLiveAnalysisError: vi.fn(),
        } as unknown as RealtimeLifecycleEffectsInput)
        return null
      }

      act(() => {
        root.render(<Harness />)
      })
    }

    renderHarness(createToken(88, 1, 1))
    expect(disconnect).toHaveBeenCalledTimes(1)

    renderHarness(createToken(88, 1, 2))
    expect(disconnect).toHaveBeenCalledTimes(2)
    expect(abortRecording).toHaveBeenCalledTimes(2)
    expect(setLiveAnalysisMetadata).toHaveBeenCalledTimes(2)
  })
})

describe('useRealtimeLifecycleEffects tab capture failure terminal cleanup', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', originalWebSocket as typeof WebSocket)
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    vi.restoreAllMocks()
  })

  const mountTabFailureHarness = (options: {
    token: RealtimeSessionToken
    abortRecording?: ReturnType<typeof vi.fn>
    disconnect?: ReturnType<typeof vi.fn>
    clearQueuedAudio?: ReturnType<typeof vi.fn>
    setLiveAnalysisMetadata?: ReturnType<typeof vi.fn>
    setLiveLifecycleState?: ReturnType<typeof vi.fn>
    analysisAbort?: AbortController
  }): {
    controls: TabFailureHarnessControls
    abortRecording: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    clearQueuedAudio: ReturnType<typeof vi.fn>
    setLiveAnalysisMetadata: ReturnType<typeof vi.fn>
    setLiveLifecycleState: ReturnType<typeof vi.fn>
    tokenRef: { current: RealtimeSessionToken | null }
  } => {
    const abortRecording = options.abortRecording ?? vi.fn()
    const disconnect = options.disconnect ?? vi.fn()
    const clearQueuedAudio = options.clearQueuedAudio ?? vi.fn()
    const setLiveAnalysisMetadata = options.setLiveAnalysisMetadata ?? vi.fn()
    const setLiveLifecycleState = options.setLiveLifecycleState ?? vi.fn()
    const tokenRef = { current: options.token as RealtimeSessionToken | null }
    const meetingIdRef = { current: options.token.meetingId as number | null }
    const onTabCaptureFailureRef: TabFailureHarnessControls['onTabCaptureFailureRef'] = { current: undefined }
    let bumpRerender: (() => void) | null = null

    function Harness() {
      const [, setTick] = useState(0)
      bumpRerender = () => setTick((value) => value + 1)

      useLifecycleEffectsTestHarness({
        audioRecorder: {
          state: 'recording',
          abortRecording,
          startRecording: vi.fn(),
        },
        realtimeStream: {
          status: { state: 'connected' },
          isAuthenticated: true,
          clearQueuedAudio,
          disconnect,
        },
        voiceActivity: { state: 'idle' },
        dualStreamActive: false,
        selectedRecordingSource: 'browser_tab',
        selectedRecordingSourceRef: { current: 'browser_tab' },
        selectedRealtimeLanguage: 'vi',
        selectedRealtimeSpeakerMode: 'single',
        selectedMicSensitivity: 'normal',
        noiseSuppressionEnabled: false,
        noiseSuppressionSupported: false,
        activeRealtimeSessionToken: tokenRef.current,
        activeRealtimeSessionTokenRef: tokenRef,
        liveLifecycleState: 'recording',
        liveMeetingIdRef: meetingIdRef,
        liveAnalysisAbortControllerRef: { current: options.analysisAbort ?? null },
        analysisPollRunIdRef: { current: 0 },
        resetRecoveryInProgressRef: { current: false },
        restartAfterReconnectRef: { current: false },
        tabTrackEndedFinalizeRef: { current: false },
        gracefulStopRef: { current: null },
        lastVoiceActivityStateRef: { current: null },
        onTabAudioTrackEndedRef: { current: undefined },
        onTabCaptureFailureRef,
        onTabPipelineStalledRef: { current: undefined },
        setLiveLifecycleState,
        setLiveError: vi.fn(),
        setLiveStatusMessage: vi.fn(),
        setLivePartialWarning: vi.fn(),
        setLiveAnalysis: vi.fn(),
        setLiveAnalysisMetadata,
        setLiveAnalysisStatus: vi.fn(),
        setLiveAnalysisError: vi.fn(),
      } as unknown as RealtimeLifecycleEffectsInput)
      return null
    }

    act(() => {
      root.render(<Harness />)
    })

    return {
      controls: {
        triggerTabFailure: (message = 'tab capture failed') => {
          act(() => {
            onTabCaptureFailureRef.current?.(message, 'track')
          })
        },
        bumpRerender: () => {
          act(() => {
            bumpRerender?.()
          })
        },
        onTabCaptureFailureRef,
      },
      abortRecording,
      disconnect,
      clearQueuedAudio,
      setLiveAnalysisMetadata,
      setLiveLifecycleState,
      tokenRef,
    }
  }

  it('uses terminal audio_capture_failure reason for tab capture failure', () => {
    const token = createToken(88, 10, 1)
    const { controls, disconnect } = mountTabFailureHarness({ token })

    controls.triggerTabFailure('Tab audio track ended unexpectedly')

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith(token, { reason: 'audio_capture_failure' })
  })

  it('runs tab capture failure cleanup once when callback fires twice', () => {
    const token = createToken(88, 10, 1)
    const analysisAbort = new AbortController()
    const abortSpy = vi.spyOn(analysisAbort, 'abort')
    const { controls, abortRecording, disconnect, clearQueuedAudio, setLiveAnalysisMetadata } = mountTabFailureHarness({
      token,
      analysisAbort,
    })

    controls.triggerTabFailure('first')
    controls.triggerTabFailure('second')

    expect(abortRecording).toHaveBeenCalledTimes(1)
    expect(clearQueuedAudio).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(setLiveAnalysisMetadata).toHaveBeenCalledTimes(1)
    expect(abortSpy).toHaveBeenCalledTimes(1)
  })

  it('does not re-run tab failure cleanup across rerenders', () => {
    const token = createToken(88, 10, 1)
    const { controls, abortRecording, disconnect, clearQueuedAudio } = mountTabFailureHarness({ token })

    controls.triggerTabFailure()
    controls.bumpRerender()
    controls.bumpRerender()

    expect(abortRecording).toHaveBeenCalledTimes(1)
    expect(clearQueuedAudio).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it('resets one-shot guard for a new recording attempt', () => {
    const abortRecording = vi.fn()
    const disconnect = vi.fn()
    const clearQueuedAudio = vi.fn()
    const tokenRef = { current: createToken(88, 10, 1) as RealtimeSessionToken | null }
    const meetingIdRef = { current: 88 as number | null }
    const onTabCaptureFailureRef: { current: ((message: string, reason: 'track' | 'stall') => void) | undefined } = {
      current: undefined,
    }

    const renderWithToken = (token: RealtimeSessionToken) => {
      tokenRef.current = token
      function Harness() {
        useLifecycleEffectsTestHarness({
          audioRecorder: {
            state: 'recording',
            abortRecording,
            startRecording: vi.fn(),
          },
          realtimeStream: {
            status: { state: 'connected' },
            isAuthenticated: true,
            clearQueuedAudio,
            disconnect,
          },
          voiceActivity: { state: 'idle' },
          dualStreamActive: false,
          selectedRecordingSource: 'browser_tab',
          selectedRecordingSourceRef: { current: 'browser_tab' },
          selectedRealtimeLanguage: 'vi',
          selectedRealtimeSpeakerMode: 'single',
          selectedMicSensitivity: 'normal',
          noiseSuppressionEnabled: false,
          noiseSuppressionSupported: false,
          activeRealtimeSessionToken: token,
          activeRealtimeSessionTokenRef: tokenRef,
          liveLifecycleState: 'recording',
          liveMeetingIdRef: meetingIdRef,
          liveAnalysisAbortControllerRef: { current: null },
          analysisPollRunIdRef: { current: 0 },
          resetRecoveryInProgressRef: { current: false },
          restartAfterReconnectRef: { current: false },
          tabTrackEndedFinalizeRef: { current: false },
          gracefulStopRef: { current: null },
          lastVoiceActivityStateRef: { current: null },
          onTabAudioTrackEndedRef: { current: undefined },
          onTabCaptureFailureRef,
          onTabPipelineStalledRef: { current: undefined },
          setLiveLifecycleState: vi.fn(),
          setLiveError: vi.fn(),
          setLiveStatusMessage: vi.fn(),
          setLivePartialWarning: vi.fn(),
          setLiveAnalysis: vi.fn(),
          setLiveAnalysisMetadata: vi.fn(),
          setLiveAnalysisStatus: vi.fn(),
          setLiveAnalysisError: vi.fn(),
        } as unknown as RealtimeLifecycleEffectsInput)
        return null
      }

      act(() => {
        root.render(<Harness />)
      })
    }

    renderWithToken(createToken(88, 10, 1))
    act(() => {
      onTabCaptureFailureRef.current?.('attempt-1', 'track')
    })
    expect(disconnect).toHaveBeenCalledTimes(1)

    renderWithToken(createToken(88, 10, 2))
    act(() => {
      onTabCaptureFailureRef.current?.('attempt-2', 'track')
    })
    expect(disconnect).toHaveBeenCalledTimes(2)
    expect(abortRecording).toHaveBeenCalledTimes(2)
    expect(clearQueuedAudio).toHaveBeenCalledTimes(2)
  })

  it('ignores stale tab failure callbacks from a previous attempt', () => {
    const abortRecording = vi.fn()
    const disconnect = vi.fn()
    const clearQueuedAudio = vi.fn()
    const setLiveLifecycleState = vi.fn()
    const tokenRef = { current: createToken(88, 10, 1) as RealtimeSessionToken | null }
    const meetingIdRef = { current: 88 as number | null }
    const onTabCaptureFailureRef: { current: ((message: string, reason: 'track' | 'stall') => void) | undefined } = {
      current: undefined,
    }
    let staleCallback: ((message: string, reason: 'track' | 'stall') => void) | undefined

    const renderWithToken = (token: RealtimeSessionToken) => {
      tokenRef.current = token
      function Harness() {
        useLifecycleEffectsTestHarness({
          audioRecorder: {
            state: 'recording',
            abortRecording,
            startRecording: vi.fn(),
          },
          realtimeStream: {
            status: { state: 'connected' },
            isAuthenticated: true,
            clearQueuedAudio,
            disconnect,
          },
          voiceActivity: { state: 'idle' },
          dualStreamActive: false,
          selectedRecordingSource: 'browser_tab',
          selectedRecordingSourceRef: { current: 'browser_tab' },
          selectedRealtimeLanguage: 'vi',
          selectedRealtimeSpeakerMode: 'single',
          selectedMicSensitivity: 'normal',
          noiseSuppressionEnabled: false,
          noiseSuppressionSupported: false,
          activeRealtimeSessionToken: token,
          activeRealtimeSessionTokenRef: tokenRef,
          liveLifecycleState: 'recording',
          liveMeetingIdRef: meetingIdRef,
          liveAnalysisAbortControllerRef: { current: null },
          analysisPollRunIdRef: { current: 0 },
          resetRecoveryInProgressRef: { current: false },
          restartAfterReconnectRef: { current: false },
          tabTrackEndedFinalizeRef: { current: false },
          gracefulStopRef: { current: null },
          lastVoiceActivityStateRef: { current: null },
          onTabAudioTrackEndedRef: { current: undefined },
          onTabCaptureFailureRef,
          onTabPipelineStalledRef: { current: undefined },
          setLiveLifecycleState,
          setLiveError: vi.fn(),
          setLiveStatusMessage: vi.fn(),
          setLivePartialWarning: vi.fn(),
          setLiveAnalysis: vi.fn(),
          setLiveAnalysisMetadata: vi.fn(),
          setLiveAnalysisStatus: vi.fn(),
          setLiveAnalysisError: vi.fn(),
        } as unknown as RealtimeLifecycleEffectsInput)
        return null
      }

      act(() => {
        root.render(<Harness />)
      })
    }

    const attempt1 = createToken(88, 10, 1)
    const attempt2 = createToken(88, 10, 2)
    renderWithToken(attempt1)
    staleCallback = onTabCaptureFailureRef.current

    renderWithToken(attempt2)
    abortRecording.mockClear()
    disconnect.mockClear()
    clearQueuedAudio.mockClear()
    setLiveLifecycleState.mockClear()

    act(() => {
      staleCallback?.('stale failure', 'track')
    })

    expect(disconnect).not.toHaveBeenCalled()
    expect(abortRecording).not.toHaveBeenCalled()
    expect(clearQueuedAudio).not.toHaveBeenCalled()
    expect(
      setLiveLifecycleState.mock.calls.filter(([state]) => state === 'failed_audio_capture'),
    ).toHaveLength(0)
  })

  it('keeps FAILED_AUDIO_CAPTURE terminal after tab failure disconnect with autoReconnect', async () => {
    const statusEvents: Array<string | undefined> = []
    const token = createToken(88, 10, 1)
    const tokenRef = { current: token as RealtimeSessionToken | null }
    const meetingIdRef = { current: 88 as number | null }
    const onTabCaptureFailureRef: { current: ((message: string, reason: 'track' | 'stall') => void) | undefined } = {
      current: undefined,
    }
    let latestStatusState: string | undefined
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    function Harness() {
      const realtimeStream = useRealtimeMeetingStream({
        meetingId: 88,
        userId: 12,
        token: 'jwt-token',
        sessionToken: token,
        enabled: true,
        autoReconnect: true,
        reconnectAttempts: 5,
        reconnectDelay: 10,
        onStatusChange: (status) => {
          statusEvents.push(status.state)
        },
      })
      latestStatusState = realtimeStream.status.state

      useLifecycleEffectsTestHarness({
        audioRecorder: {
          state: 'recording',
          abortRecording: vi.fn(),
          startRecording: vi.fn(),
        },
        realtimeStream,
        voiceActivity: { state: 'idle' },
        dualStreamActive: false,
        selectedRecordingSource: 'browser_tab',
        selectedRecordingSourceRef: { current: 'browser_tab' },
        selectedRealtimeLanguage: 'vi',
        selectedRealtimeSpeakerMode: 'single',
        selectedMicSensitivity: 'normal',
        noiseSuppressionEnabled: false,
        noiseSuppressionSupported: false,
        activeRealtimeSessionToken: token,
        activeRealtimeSessionTokenRef: tokenRef,
        liveLifecycleState: 'recording',
        liveMeetingIdRef: meetingIdRef,
        liveAnalysisAbortControllerRef: { current: null },
        analysisPollRunIdRef: { current: 0 },
        resetRecoveryInProgressRef: { current: false },
        restartAfterReconnectRef: { current: false },
        tabTrackEndedFinalizeRef: { current: false },
        gracefulStopRef: { current: null },
        lastVoiceActivityStateRef: { current: null },
        onTabAudioTrackEndedRef: { current: undefined },
        onTabCaptureFailureRef,
        onTabPipelineStalledRef: { current: undefined },
        setLiveLifecycleState: vi.fn(),
        setLiveError: vi.fn(),
        setLiveStatusMessage: vi.fn(),
        setLivePartialWarning: vi.fn(),
        setLiveAnalysis: vi.fn(),
        setLiveAnalysisMetadata: vi.fn(),
        setLiveAnalysisStatus: vi.fn(),
        setLiveAnalysisError: vi.fn(),
      } as unknown as RealtimeLifecycleEffectsInput)
      return null
    }

    act(() => {
      root.render(<Harness />)
    })

    const socket = MockWebSocket.instances[0]
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => {
      socket.open()
    })
    await flush()
    act(() => {
      socket.receive({
        type: 'session.ready',
        meetingId: 88,
        authenticated: true,
        activeConnections: 1,
      })
    })
    await flush()
    statusEvents.length = 0

    act(() => {
      onTabCaptureFailureRef.current?.('tab capture failed', 'track')
    })
    await flush()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    await flush()

    expect(MockWebSocket.instances).toHaveLength(1)
    expect(latestStatusState).toBe('FAILED_AUDIO_CAPTURE')
    expect(statusEvents).toContain('FAILED_AUDIO_CAPTURE')
    expect(statusEvents).not.toContain('reconnecting')
    expect(statusEvents).not.toContain('stopped')
    expect(statusEvents).not.toContain('completed')
    expect(statusEvents.filter((state) => state === 'error')).toHaveLength(0)
  })
})
