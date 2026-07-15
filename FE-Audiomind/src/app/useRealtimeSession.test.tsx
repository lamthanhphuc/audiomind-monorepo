import { createRoot } from 'react-dom/client'
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRealtimeSession, type UseRealtimeSessionInput } from './useRealtimeSession'
import { useTerminalAudioCaptureCleanup } from './useTerminalAudioCaptureCleanup'
import type { RealtimeSessionToken } from '../hooks/useRealtimeMeetingStream'
import {
  REALTIME_TINY_CHUNK_MAX_BYTES,
  REALTIME_TINY_CHUNK_MIN_RECORDING_SEC,
  REALTIME_TINY_CHUNK_STREAK_THRESHOLD,
} from '../services/config'

vi.mock('../services/api', () => ({
  createRealtimeMeeting: vi.fn(),
  getAnalysis: vi.fn(),
  getTranscript: vi.fn(),
  reanalyzeMeetingAnalysis: vi.fn(),
  submitRealtimeFinalAudioFallback: vi.fn(),
  ApiError: class ApiError extends Error {},
}))

import { getTranscript, submitRealtimeFinalAudioFallback } from '../services/api'
import { runLiveRecordingStopSequence } from './App'

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

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

type SharedHarnessRefs = {
  tokenRef: { current: RealtimeSessionToken | null }
  meetingIdRef: { current: number | null }
  recordingSessionIdRef: { current: number }
  tinyChunkStreakRef: { current: number }
}

type SessionHarnessControls = {
  handleLiveChunkReady: (chunk: Blob, sessionId: number) => Promise<void>
  handleLiveRecordingComplete: (
    fullAudio: Blob,
    sessionId: number,
    recordedMeta?: { mimeType: string; extension: 'webm' | 'm4a' },
  ) => Promise<void>
  bumpRerender: () => void
}

type SessionHarnessMocks = {
  setLiveLifecycleState: ReturnType<typeof vi.fn>
  setLiveError: ReturnType<typeof vi.fn>
  setLiveAnalysisMetadata: ReturnType<typeof vi.fn>
  setLiveAnalysisStatus: ReturnType<typeof vi.fn>
  setHydratedLiveTranscriptSegments: ReturnType<typeof vi.fn>
  setLivePartialWarning: ReturnType<typeof vi.fn>
  setLiveStatusMessage: ReturnType<typeof vi.fn>
  pollRealtimeAnalysisAfterStop: ReturnType<typeof vi.fn>
  abortRecording: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  clearQueuedAudio: ReturnType<typeof vi.fn>
  sendAudioChunk: ReturnType<typeof vi.fn>
  stopStream: ReturnType<typeof vi.fn>
  cleanupRecordingResources: ReturnType<typeof vi.fn>
  failedAudioCaptureCleanupKeyRef: { current: string | null }
  tokenRef: { current: RealtimeSessionToken | null }
  meetingIdRef: { current: number | null }
  recordingSessionIdRef: { current: number }
  switchAttempt: (token: RealtimeSessionToken) => void
  clearSideEffectMocks: () => void
}

const mountSessionHarness = (
  root: ReturnType<typeof createRoot>,
  options?: {
    token?: RealtimeSessionToken
    meetingId?: number
    recordingSessionId?: number
    duration?: number
    rms?: number | null
    sharedRefs?: SharedHarnessRefs
  },
): SessionHarnessControls & SessionHarnessMocks => {
  const token = options?.token ?? createToken(42, 7, 1)
  const meetingId = options?.meetingId ?? 42
  const recordingSessionId = options?.recordingSessionId ?? 7
  const tokenRef = options?.sharedRefs?.tokenRef ?? { current: token as RealtimeSessionToken | null }
  const meetingIdRef = options?.sharedRefs?.meetingIdRef ?? { current: meetingId as number | null }
  const recordingSessionIdRef = options?.sharedRefs?.recordingSessionIdRef ?? { current: recordingSessionId }
  const tinyChunkStreakRef = options?.sharedRefs?.tinyChunkStreakRef ?? { current: 0 }

  tokenRef.current = token
  meetingIdRef.current = meetingId
  recordingSessionIdRef.current = recordingSessionId

  const stopStream = vi.fn().mockResolvedValue(true)
  const abortRecording = vi.fn()
  const disconnect = vi.fn()
  const clearQueuedAudio = vi.fn()
  const sendAudioChunk = vi.fn().mockResolvedValue(undefined)
  const cleanupRecordingResources = vi.fn()
  const setLiveLifecycleState = vi.fn()
  const setLiveError = vi.fn()
  const setLiveAnalysisMetadata = vi.fn()
  const setLiveStatusMessage = vi.fn()
  const setLivePartialWarning = vi.fn()
  const setLiveAnalysis = vi.fn()
  const setLiveAnalysisStatus = vi.fn()
  const setLiveAnalysisError = vi.fn()
  const setHydratedLiveTranscriptSegments = vi.fn()
  const pollRealtimeAnalysisAfterStop = vi.fn()

  let bumpRerender: (() => void) | null = null
  const controls: Partial<SessionHarnessControls> = {}
  let failedAudioCaptureCleanupKeyRef: { current: string | null } = { current: null }

  const clearSideEffectMocks = () => {
    setLiveLifecycleState.mockClear()
    setLiveError.mockClear()
    setLiveAnalysisMetadata.mockClear()
    setLiveAnalysisStatus.mockClear()
    setHydratedLiveTranscriptSegments.mockClear()
    setLivePartialWarning.mockClear()
    setLiveStatusMessage.mockClear()
    pollRealtimeAnalysisAfterStop.mockClear()
    abortRecording.mockClear()
    disconnect.mockClear()
    clearQueuedAudio.mockClear()
    cleanupRecordingResources.mockClear()
    stopStream.mockClear()
    vi.mocked(submitRealtimeFinalAudioFallback).mockClear()
    vi.mocked(getTranscript).mockClear()
  }

  const switchAttempt = (nextToken: RealtimeSessionToken) => {
    tokenRef.current = nextToken
    meetingIdRef.current = nextToken.meetingId
    recordingSessionIdRef.current = nextToken.recordingSessionId
  }

  function Harness() {
    const [, setTick] = useState(0)
    bumpRerender = () => setTick((value) => value + 1)

    const audioRecorder = {
      state: 'recording' as const,
      duration: options?.duration ?? REALTIME_TINY_CHUNK_MIN_RECORDING_SEC,
      recordingSessionId,
      abortRecording,
      startRecording: vi.fn().mockResolvedValue(recordingSessionId),
      stopRecording: vi.fn(),
      getCurrentRms: vi.fn(() => options?.rms ?? 0.005),
      cleanupRecordingResources,
    }

    const realtimeStream = {
      status: {
        resetRequired: false,
        message: null,
        state: 'connected' as const,
      },
      isAuthenticated: true,
      transcripts: [],
      keywords: [],
      clearQueuedAudio,
      disconnect,
      sendAudioChunk,
      stopStream,
      waitForSessionReady: vi.fn().mockResolvedValue(undefined),
    }

    const terminalCleanup = useTerminalAudioCaptureCleanup({
      audioRecorder,
      realtimeStream,
      activeRealtimeSessionTokenRef: tokenRef,
      liveMeetingIdRef: meetingIdRef,
      liveAnalysisAbortControllerRef: { current: null },
      analysisPollRunIdRef: { current: 0 },
      setLiveLifecycleState,
      setLiveError,
      setLiveAnalysis,
      setLiveAnalysisMetadata,
      setLiveAnalysisStatus,
      setLiveAnalysisError,
      setLivePartialWarning,
      setLiveStatusMessage,
    })
    failedAudioCaptureCleanupKeyRef = terminalCleanup.failedAudioCaptureCleanupKeyRef

    const session = useRealtimeSession({
      audioRecorder,
      realtimeStream,
      dualStreamActive: false,
      selectedDomainMode: 'general',
      selectedRealtimeLanguage: 'vi',
      selectedRecordingSource: 'mic',
      selectedRecordingSourceRef: { current: 'mic' },
      joinMeetingIdInput: '',
      liveLifecycleState: 'recording',
      liveAnalysisMetadata: null,
      activeRealtimeSessionTokenRef: tokenRef,
      liveMeetingIdRef: meetingIdRef,
      liveRecordingSessionIdRef: recordingSessionIdRef,
      realtimeAttemptIdRef: { current: token.attemptId },
      hydrationRunIdRef: { current: 0 },
      analysisPollRunIdRef: { current: 0 },
      liveTinyChunkStreakRef: tinyChunkStreakRef,
      liveAnalysisAbortControllerRef: { current: null },
      handleDualChunkReadyRef: { current: undefined },
      navigateFeatureScene: vi.fn(),
      setActiveRealtimeSessionToken: vi.fn(),
      setLiveMeetingId: vi.fn(),
      setLiveError,
      setLiveErrorCode: vi.fn(),
      setLivePartialWarning,
      setLiveStatusMessage,
      setLiveAnalysis,
      setLiveAnalysisMetadata,
      setLiveAnalysisStatus,
      setLiveAnalysisError,
      setHydratedLiveTranscriptSegments,
      setLiveLifecycleState,
      setShowJoinOtherMeeting: vi.fn(),
      runTerminalAudioCaptureCleanupRef: terminalCleanup.runTerminalAudioCaptureCleanupRef,
      failedAudioCaptureCleanupKeyRef: terminalCleanup.failedAudioCaptureCleanupKeyRef,
      sessionHelpers: {
        pollRealtimeAnalysisAfterStop,
        hydrateLiveTranscriptSegments: vi.fn().mockResolvedValue([]),
        runLiveRecordingStopSequence,
        beginGracefulStopLifecycle: vi.fn(),
        resolveFreshRealtimeMeetingId: vi.fn((meeting: { id?: unknown }) => Number(meeting.id)),
        shouldAttemptRealtimeFinalAudioFallback: vi.fn().mockReturnValue(true),
        buildFinalAudioBlobReadyLogPayload: vi.fn((id, bytes) => ({ meetingId: id, bytes })),
        resolveTranscriptPartialState: vi.fn().mockReturnValue(false),
        isCurrentLiveRecordingSession: (
          completedSessionId: number,
          completedMeetingId: number | null,
          currentSessionId: number,
          currentMeetingId: number | null,
        ) => (
          completedSessionId === currentSessionId
          && completedMeetingId === currentMeetingId
        ),
      },
      analysisHelpers: {
        getRealtimeAnalysisFailureMessage: vi.fn(),
        metadataFromAnalysisError: vi.fn(),
        hasStructuredAnalysisData: vi.fn(),
        getAnalysisStatusValue: vi.fn(),
        isFailedAnalysisStatus: vi.fn(),
      },
    } as unknown as UseRealtimeSessionInput)

    controls.handleLiveChunkReady = session.handleLiveChunkReady
    controls.handleLiveRecordingComplete = session.handleLiveRecordingComplete

    return null
  }

  act(() => {
    root.render(<Harness />)
  })

  return {
    handleLiveChunkReady: controls.handleLiveChunkReady!,
    handleLiveRecordingComplete: controls.handleLiveRecordingComplete!,
    bumpRerender: () => bumpRerender?.(),
    setLiveLifecycleState,
    setLiveError,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setHydratedLiveTranscriptSegments,
    setLivePartialWarning,
    setLiveStatusMessage,
    pollRealtimeAnalysisAfterStop,
    abortRecording,
    disconnect,
    clearQueuedAudio,
    sendAudioChunk,
    stopStream,
    cleanupRecordingResources,
    failedAudioCaptureCleanupKeyRef,
    tokenRef,
    meetingIdRef,
    recordingSessionIdRef,
    switchAttempt,
    clearSideEffectMocks,
  }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const createDeferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const expectNoStaleCompletionSideEffects = (harness: SessionHarnessMocks) => {
  expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('failed_audio_capture')
  expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('no_transcript_after_finalize')
  expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('stopped_no_analysis')
  expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('stopped')
  expect(harness.setLiveError).not.toHaveBeenCalledWith(null)
  expect(harness.setLiveAnalysisMetadata).not.toHaveBeenCalled()
  expect(harness.setHydratedLiveTranscriptSegments).not.toHaveBeenCalled()
  expect(harness.pollRealtimeAnalysisAfterStop).not.toHaveBeenCalled()
  expect(harness.disconnect).not.toHaveBeenCalled()
  expect(harness.abortRecording).not.toHaveBeenCalled()
  expect(harness.cleanupRecordingResources).not.toHaveBeenCalled()
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

describe('useRealtimeSession terminal audio capture failure', () => {
  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    vi.restoreAllMocks()
  })

  const sendTinySilentChunks = async (
    handleLiveChunkReady: SessionHarnessControls['handleLiveChunkReady'],
    sessionId: number,
    count: number,
  ) => {
    const chunk = new Blob([new Uint8Array(REALTIME_TINY_CHUNK_MAX_BYTES - 1)], { type: 'audio/webm;codecs=opus' })
    for (let index = 0; index < count; index += 1) {
      await act(async () => {
        await handleLiveChunkReady(chunk, sessionId)
      })
    }
  }

  it('uses terminal disconnect reason when tiny-chunk threshold is reached', async () => {
    const token = createToken(42, 7, 1)
    const harness = mountSessionHarness(root, { token, recordingSessionId: 7 })

    await sendTinySilentChunks(
      harness.handleLiveChunkReady,
      7,
      REALTIME_TINY_CHUNK_STREAK_THRESHOLD,
    )

    expect(harness.disconnect).toHaveBeenCalledTimes(1)
    expect(harness.disconnect).toHaveBeenCalledWith(token, { reason: 'audio_capture_failure' })
    expect(harness.abortRecording).toHaveBeenCalledTimes(1)
    expect(harness.clearQueuedAudio).toHaveBeenCalledTimes(1)
    expect(
      harness.setLiveLifecycleState.mock.calls.filter(([state]) => state === 'failed_audio_capture'),
    ).toHaveLength(1)
  })

  it('runs tiny-chunk terminal cleanup only once across repeated thresholds', async () => {
    const harness = mountSessionHarness(root, { recordingSessionId: 7 })

    await sendTinySilentChunks(harness.handleLiveChunkReady, 7, REALTIME_TINY_CHUNK_STREAK_THRESHOLD)
    const sendCountAfterFirstThreshold = harness.sendAudioChunk.mock.calls.length

    await sendTinySilentChunks(harness.handleLiveChunkReady, 7, REALTIME_TINY_CHUNK_STREAK_THRESHOLD)

    expect(harness.disconnect).toHaveBeenCalledTimes(1)
    expect(harness.abortRecording).toHaveBeenCalledTimes(1)
    expect(harness.clearQueuedAudio).toHaveBeenCalledTimes(1)
    expect(harness.sendAudioChunk.mock.calls.length).toBe(sendCountAfterFirstThreshold)
    expect(harness.setLiveAnalysisMetadata).toHaveBeenCalledTimes(1)
  })

  it('resets tiny-chunk one-shot guard for a new recording attempt', async () => {
    const sharedRefs: SharedHarnessRefs = {
      tokenRef: { current: createToken(42, 7, 1) },
      meetingIdRef: { current: 42 },
      recordingSessionIdRef: { current: 7 },
      tinyChunkStreakRef: { current: 0 },
    }

    const attempt1 = mountSessionHarness(root, {
      token: createToken(42, 7, 1),
      recordingSessionId: 7,
      sharedRefs,
    })
    sharedRefs.tinyChunkStreakRef.current = 0
    await sendTinySilentChunks(attempt1.handleLiveChunkReady, 7, REALTIME_TINY_CHUNK_STREAK_THRESHOLD)
    expect(attempt1.disconnect).toHaveBeenCalledTimes(1)

    const attempt2 = mountSessionHarness(root, {
      token: createToken(42, 8, 2),
      recordingSessionId: 8,
      sharedRefs,
    })
    sharedRefs.tinyChunkStreakRef.current = 0
    await sendTinySilentChunks(attempt2.handleLiveChunkReady, 8, REALTIME_TINY_CHUNK_STREAK_THRESHOLD)
    expect(attempt2.disconnect).toHaveBeenCalledTimes(1)
    expect(attempt2.abortRecording).toHaveBeenCalledTimes(1)
  })

  it('ignores stale tiny-chunk signals from a previous attempt', async () => {
    const sharedRefs: SharedHarnessRefs = {
      tokenRef: { current: createToken(42, 7, 1) },
      meetingIdRef: { current: 42 },
      recordingSessionIdRef: { current: 7 },
      tinyChunkStreakRef: { current: 0 },
    }

    const attempt1 = mountSessionHarness(root, {
      token: createToken(42, 7, 1),
      recordingSessionId: 7,
      sharedRefs,
    })
    const staleHandler = attempt1.handleLiveChunkReady

    mountSessionHarness(root, {
      token: createToken(42, 8, 2),
      recordingSessionId: 8,
      sharedRefs,
    })

    attempt1.disconnect.mockClear()
    attempt1.abortRecording.mockClear()

    await sendTinySilentChunks(staleHandler, 7, REALTIME_TINY_CHUNK_STREAK_THRESHOLD)

    expect(attempt1.disconnect).not.toHaveBeenCalled()
    expect(attempt1.abortRecording).not.toHaveBeenCalled()
  })

  it('keeps final fallback FAILED_AUDIO_CAPTURE terminal and skips stopped transitions', async () => {
    vi.mocked(submitRealtimeFinalAudioFallback).mockResolvedValue({
      meeting_id: 42,
      status: 'FAILED_AUDIO_CAPTURE',
      transcriptRows: 0,
    })

    const harness = mountSessionHarness(root, { recordingSessionId: 7 })
    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })

    await act(async () => {
      await harness.handleLiveRecordingComplete(audio, 7)
    })
    await flush()

    expect(
      harness.setLiveLifecycleState.mock.calls.filter(([state]) => state === 'failed_audio_capture'),
    ).toHaveLength(1)
    expect(
      harness.setLiveLifecycleState.mock.calls.some(([state]) => state === 'stopped'),
    ).toBe(false)
    expect(
      harness.setLiveLifecycleState.mock.calls.some(([state]) => state === 'stopped_no_analysis'),
    ).toBe(false)
    expect(
      harness.setLiveLifecycleState.mock.calls.some(([state]) => state === 'no_transcript_after_finalize'),
    ).toBe(false)
    expect(harness.setLiveError).not.toHaveBeenLastCalledWith(null)
    expect(harness.setLiveAnalysisStatus).not.toHaveBeenCalledWith('polling')
    expect(harness.pollRealtimeAnalysisAfterStop).not.toHaveBeenCalled()
  })

  it('writes final fallback FAILED_AUDIO_CAPTURE metadata', async () => {
    vi.mocked(submitRealtimeFinalAudioFallback).mockResolvedValue({
      meeting_id: 42,
      status: 'FAILED_AUDIO_CAPTURE',
      transcriptRows: 0,
    })

    const harness = mountSessionHarness(root, { recordingSessionId: 7 })
    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })

    await act(async () => {
      await harness.handleLiveRecordingComplete(audio, 7)
    })
    await flush()

    expect(harness.setLiveAnalysisMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'FAILED_AUDIO_CAPTURE',
        finalized: true,
        transcriptRows: 0,
      }),
    )
  })

  it('ignores stale FAILED_AUDIO_CAPTURE fallback after attempt switch on same harness', async () => {
    const fallbackDeferred = createDeferred<Awaited<ReturnType<typeof submitRealtimeFinalAudioFallback>>>()
    let fallbackStartedResolve: (() => void) | null = null
    const fallbackStarted = new Promise<void>((resolve) => {
      fallbackStartedResolve = resolve
    })
    vi.mocked(submitRealtimeFinalAudioFallback).mockImplementation(() => {
      fallbackStartedResolve?.()
      return fallbackDeferred.promise
    })

    const harness = mountSessionHarness(root, {
      token: createToken(42, 7, 1),
      recordingSessionId: 7,
    })
    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })
    let completionPromise!: Promise<void>

    await act(async () => {
      completionPromise = harness.handleLiveRecordingComplete(audio, 7)
      await fallbackStarted
    })

    harness.switchAttempt(createToken(42, 8, 2))
    harness.clearSideEffectMocks()

    await act(async () => {
      fallbackDeferred.resolve({
        meeting_id: 42,
        status: 'FAILED_AUDIO_CAPTURE',
        transcriptRows: 0,
      })
      await completionPromise
    })

    expectNoStaleCompletionSideEffects(harness)
  })

  it('ignores stale successful fallback transcript after attempt switch on same harness', async () => {
    const fallbackDeferred = createDeferred<Awaited<ReturnType<typeof submitRealtimeFinalAudioFallback>>>()
    let fallbackStartedResolve: (() => void) | null = null
    const fallbackStarted = new Promise<void>((resolve) => {
      fallbackStartedResolve = resolve
    })
    vi.mocked(submitRealtimeFinalAudioFallback).mockImplementation(() => {
      fallbackStartedResolve?.()
      return fallbackDeferred.promise
    })
    vi.mocked(getTranscript).mockResolvedValue({
      transcripts: [{ text: 'stale attempt 1 transcript', speaker: 'A', start: 0, end: 1 }],
    } as never)

    const harness = mountSessionHarness(root, {
      token: createToken(42, 7, 1),
      recordingSessionId: 7,
    })
    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })
    let completionPromise!: Promise<void>

    await act(async () => {
      completionPromise = harness.handleLiveRecordingComplete(audio, 7)
      await fallbackStarted
    })

    harness.switchAttempt(createToken(42, 8, 2))
    harness.clearSideEffectMocks()

    await act(async () => {
      fallbackDeferred.resolve({
        meeting_id: 42,
        status: 'OK',
        transcriptRows: 3,
      })
      await completionPromise
    })

    expect(harness.setHydratedLiveTranscriptSegments).not.toHaveBeenCalled()
    expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('stopped')
    expect(harness.setLiveError).not.toHaveBeenCalledWith(null)
    expect(harness.setLivePartialWarning).not.toHaveBeenCalledWith(null)
    expect(harness.pollRealtimeAnalysisAfterStop).not.toHaveBeenCalled()
    expect(harness.disconnect).not.toHaveBeenCalled()
  })

  it('ignores stale NO_TRANSCRIPT fallback after attempt switch on same harness', async () => {
    const fallbackDeferred = createDeferred<Awaited<ReturnType<typeof submitRealtimeFinalAudioFallback>>>()
    let fallbackStartedResolve: (() => void) | null = null
    const fallbackStarted = new Promise<void>((resolve) => {
      fallbackStartedResolve = resolve
    })
    vi.mocked(submitRealtimeFinalAudioFallback).mockImplementation(() => {
      fallbackStartedResolve?.()
      return fallbackDeferred.promise
    })

    const harness = mountSessionHarness(root, {
      token: createToken(42, 7, 1),
      recordingSessionId: 7,
    })
    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })
    let completionPromise!: Promise<void>

    await act(async () => {
      completionPromise = harness.handleLiveRecordingComplete(audio, 7)
      await fallbackStarted
    })

    harness.switchAttempt(createToken(42, 8, 2))
    harness.clearSideEffectMocks()

    await act(async () => {
      fallbackDeferred.resolve({
        meeting_id: 42,
        status: 'NO_TRANSCRIPT',
        transcriptRows: 0,
      })
      await completionPromise
    })

    expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('no_transcript_after_finalize')
    expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('stopped_no_analysis')
    expect(harness.setLiveError).not.toHaveBeenCalledWith(null)
    expect(harness.setLiveAnalysisMetadata).not.toHaveBeenCalled()
    expect(harness.pollRealtimeAnalysisAfterStop).not.toHaveBeenCalled()
    expect(harness.disconnect).not.toHaveBeenCalled()
  })

  it('ignores stale getTranscript result after attempt switch mid-fallback success', async () => {
    const transcriptDeferred = createDeferred<{ transcripts: Array<{ text: string; speaker: string; start: number; end: number }> }>()
    let transcriptStartedResolve: (() => void) | null = null
    const transcriptStarted = new Promise<void>((resolve) => {
      transcriptStartedResolve = resolve
    })

    vi.mocked(submitRealtimeFinalAudioFallback).mockResolvedValue({
      meeting_id: 42,
      status: 'OK',
      transcriptRows: 2,
    })
    vi.mocked(getTranscript).mockImplementation(() => {
      transcriptStartedResolve?.()
      return transcriptDeferred.promise as never
    })

    const harness = mountSessionHarness(root, {
      token: createToken(42, 7, 1),
      recordingSessionId: 7,
    })
    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })
    let completionPromise!: Promise<void>

    await act(async () => {
      completionPromise = harness.handleLiveRecordingComplete(audio, 7)
      await transcriptStarted
    })

    harness.switchAttempt(createToken(42, 8, 2))
    harness.clearSideEffectMocks()

    await act(async () => {
      transcriptDeferred.resolve({
        transcripts: [{ text: 'stale transcript from attempt 1', speaker: 'A', start: 0, end: 1 }],
      })
      await completionPromise
    })

    expect(harness.setHydratedLiveTranscriptSegments).not.toHaveBeenCalled()
    expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('stopped')
    expect(harness.setLiveError).not.toHaveBeenCalledWith(null)
    expect(harness.pollRealtimeAnalysisAfterStop).not.toHaveBeenCalled()
    expect(harness.disconnect).not.toHaveBeenCalled()
  })

  it('keeps current-attempt NO_TRANSCRIPT completion behavior when attempt does not change', async () => {
    vi.mocked(submitRealtimeFinalAudioFallback).mockResolvedValue({
      meeting_id: 42,
      status: 'NO_TRANSCRIPT',
      transcriptRows: 0,
    })

    const harness = mountSessionHarness(root, { recordingSessionId: 7 })
    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })

    await act(async () => {
      await harness.handleLiveRecordingComplete(audio, 7)
    })
    await flush()

    expect(harness.setLiveLifecycleState).toHaveBeenCalledWith('no_transcript_after_finalize')
    expect(harness.setLiveLifecycleState).toHaveBeenCalledWith('stopped_no_analysis')
    expect(harness.setLiveError).toHaveBeenCalledWith(null)
    expect(harness.setLiveAnalysisMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
        finalized: true,
        transcriptRows: 0,
      }),
    )
    expect(harness.pollRealtimeAnalysisAfterStop).not.toHaveBeenCalled()
  })

  it('keeps current-attempt successful fallback and starts analysis polling', async () => {
    vi.mocked(submitRealtimeFinalAudioFallback).mockResolvedValue({
      meeting_id: 42,
      status: 'OK',
      transcriptRows: 2,
    })
    vi.mocked(getTranscript).mockResolvedValue({
      transcripts: [{ text: 'hello world', speaker: 'A', start: 0, end: 1 }],
    } as never)

    const harness = mountSessionHarness(root, { recordingSessionId: 7 })
    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })

    await act(async () => {
      await harness.handleLiveRecordingComplete(audio, 7)
    })
    await flush()

    expect(harness.setHydratedLiveTranscriptSegments).toHaveBeenCalled()
    expect(harness.setLiveLifecycleState).toHaveBeenCalledWith('stopped')
    expect(harness.setLiveError).toHaveBeenCalledWith(null)
    expect(harness.setLiveAnalysisStatus).toHaveBeenCalledWith('polling')
    expect(harness.pollRealtimeAnalysisAfterStop).toHaveBeenCalled()
  })

  it('ignores stale stop-sequence finalizing_transcript after attempt switch on same harness', async () => {
    const stopDeferred = createDeferred<boolean>()
    let stopStartedResolve: (() => void) | null = null
    const stopStarted = new Promise<void>((resolve) => {
      stopStartedResolve = resolve
    })

    const harness = mountSessionHarness(root, {
      token: createToken(42, 7, 1),
      recordingSessionId: 7,
    })
    harness.stopStream.mockImplementation(() => {
      stopStartedResolve?.()
      return stopDeferred.promise
    })

    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })
    let completionPromise!: Promise<void>

    await act(async () => {
      completionPromise = harness.handleLiveRecordingComplete(audio, 7)
      await stopStarted
    })

    expect(harness.setLiveLifecycleState).toHaveBeenCalledWith('stopping')
    harness.switchAttempt(createToken(42, 8, 2))
    harness.clearSideEffectMocks()

    await act(async () => {
      stopDeferred.resolve(true)
      await completionPromise
    })

    expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('finalizing_transcript')
    expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('stopped')
    expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('stopped_no_analysis')
    expect(harness.setLiveLifecycleState).not.toHaveBeenCalledWith('no_transcript_after_finalize')
    expect(harness.setLiveError).not.toHaveBeenCalledWith(null)
    expect(submitRealtimeFinalAudioFallback).not.toHaveBeenCalled()
    expect(harness.pollRealtimeAnalysisAfterStop).not.toHaveBeenCalled()
    expect(harness.disconnect).not.toHaveBeenCalled()
    expect(harness.setLiveAnalysisMetadata).not.toHaveBeenCalled()
  })

  it('sets stopping then finalizing_transcript for current-attempt stop sequence', async () => {
    vi.mocked(submitRealtimeFinalAudioFallback).mockResolvedValue({
      meeting_id: 42,
      status: 'NO_TRANSCRIPT',
      transcriptRows: 0,
    })

    const harness = mountSessionHarness(root, { recordingSessionId: 7 })
    const audio = new Blob([new Uint8Array(4096)], { type: 'audio/webm;codecs=opus' })

    await act(async () => {
      await harness.handleLiveRecordingComplete(audio, 7)
    })
    await flush()

    expect(harness.stopStream).toHaveBeenCalled()
    expect(harness.setLiveLifecycleState).toHaveBeenCalledWith('stopping')
    expect(harness.setLiveLifecycleState).toHaveBeenCalledWith('finalizing_transcript')
  })
})
