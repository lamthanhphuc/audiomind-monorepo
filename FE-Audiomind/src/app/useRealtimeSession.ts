import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { DashboardScene } from '../components/dashboard/DashboardLayout'
import type { AudioRecorderState } from '../hooks/useAudioRecorder'
import type { DualTabMicStreamId } from '../hooks/useDualAudioRecorder'
import {
  type RealtimeAudioStreamId,
  type RealtimeLanguage,
  type RealtimeSessionToken,
  type RealtimeStatusEvent,
  type TranscriptSegment,
} from '../hooks/useRealtimeMeetingStream'
import {
  BROWSER_TAB_CAPTURE_TELEMETRY,
  isBrowserTabRecordingSource,
  REALTIME_MEET_CAPTURE_TITLE_KEY,
  getRecordingSourceTinyChunkError,
  type RecordingSource,
} from '../constants/recordingSource'
import type { DomainMode } from '../constants/domainMode'
import {
  REALTIME_MIN_FALLBACK_AUDIO_BYTES,
  REALTIME_TINY_CHUNK_MAX_BYTES,
  REALTIME_TINY_CHUNK_MAX_RMS,
  REALTIME_TINY_CHUNK_MIN_RECORDING_SEC,
  REALTIME_TINY_CHUNK_STREAK_THRESHOLD,
} from '../services/config'
import {
  ApiError,
  createRealtimeMeeting,
  getAnalysis,
  getTranscript,
  reanalyzeMeetingAnalysis,
  submitRealtimeFinalAudioFallback,
  type AnalysisScopeOptions,
} from '../services/api'
import type { AiAnalysis } from '../types'
import {
  mergeHydratedTranscriptWithLive,
  mergeTranscriptSegments,
  normalizePersistedTranscriptSegments,
} from '../utils/transcript'
import { realtimeError, realtimeInfo, realtimeWarn } from '../utils/realtimeTelemetry'
import { buildLiveAnalysisMetadata } from './liveAnalysisMetadata'
import { isNoTranscriptTerminalLifecycle, type LiveLifecycleState } from './liveLifecycle'
import { isTerminalAudioCaptureAttempt } from './terminalAudioCaptureCleanup'
import type { RunTerminalAudioCaptureCleanupRef } from './useTerminalAudioCaptureCleanup'

const REALTIME_ANALYSIS_POLL_MAX_ATTEMPTS = 45
const STREAM_STOP_DISCONNECT_FALLBACK_DELAY_MS = 500

type LiveAnalysisStatus = 'idle' | 'polling' | 'completed' | 'pending' | 'failed'

type RealtimeAnalysisPollResult = {
  status: 'completed' | 'pending' | 'failed'
  analysis: AiAnalysis | null
  metadata: AiAnalysis | null
  reason?: string
}

type RealtimeAnalysisPollOptions = {
  sessionToken?: RealtimeSessionToken | null
  isSessionActive?: (token: RealtimeSessionToken | null) => boolean
  analysisPollRunId?: number
  analysisScope?: Pick<AnalysisScopeOptions, 'recordingSessionId' | 'attemptId'>
}

type HydrationOptions = {
  backendPartial?: boolean
  backendResetRequired?: boolean
  currentLiveSegments?: TranscriptSegment[]
  hydrationRunId?: number
  isHydrationRunActive?: (hydrationRunId: number) => boolean
}

type LiveRecordingStopSequenceResult = {
  stopSent: boolean
  stopIncomplete: boolean
  stale?: boolean
}

type LiveRecordingStopSequenceInput = {
  meetingId: number | null
  sessionId: number
  stopStream?: () => Promise<boolean>
  setLifecycleState: (state: LiveLifecycleState) => void
  source?: string
  isCurrentAttempt?: () => boolean
}

type RealtimeFinalAudioFallbackInput = {
  mergedTranscriptCount: number
  fullAudioBytes: number
  minFallbackAudioBytes: number
  stopIncomplete: boolean
  partialState: boolean
  resetRequired: boolean
  streamState: RealtimeStatusEvent['state']
}

type AudioRecorderLike = {
  state: AudioRecorderState
  duration: number
  recordingSessionId: number
  abortRecording: () => void
  startRecording: () => Promise<number | null>
  stopRecording: () => void
  getCurrentRms: () => number | null
  getActiveStreamIds?: () => Array<'tab' | 'mic'>
  cleanupRecordingResources: () => void
}

type RealtimeStreamLike = {
  status: {
    resetRequired?: boolean
    message?: string | null
    state?: RealtimeStatusEvent['state']
    errorCode?: string
    status?: string
    dualStreamBackendEnabled?: boolean
  }
  isAuthenticated: boolean
  transcripts: TranscriptSegment[]
  keywords: unknown[]
  clearQueuedAudio?: () => void
  clearTranscripts?: () => void
  clearKeywords?: () => void
  disconnect: (
    token: RealtimeSessionToken | null,
    options?: { reason?: 'user' | 'audio_capture_failure' | 'default' },
  ) => void
  configureDualStreams?: (streamIds: Array<'tab' | 'mic'>) => void
  waitForSessionReady: (
    timeoutMs?: number,
    expectedMeetingId?: number | null,
    expectedSessionToken?: RealtimeSessionToken | null,
  ) => Promise<void>
  sendAudioChunk: (chunk: Blob, meetingId: string, streamId?: RealtimeAudioStreamId) => Promise<void>
  stopStream?: () => Promise<boolean>
}

export type RealtimeSessionHelpers = {
  pollRealtimeAnalysisAfterStop: (
    meetingId: number,
    signal: AbortSignal,
    fetchAnalysis: typeof getAnalysis,
    maxAttempts: number,
    options: RealtimeAnalysisPollOptions,
  ) => Promise<RealtimeAnalysisPollResult>
  hydrateLiveTranscriptSegments: (
    meetingId: number,
    fetchTranscript: typeof getTranscript,
    sessionToken: RealtimeSessionToken | null,
    isSessionActive: ((token: RealtimeSessionToken | null) => boolean) | null,
    options: HydrationOptions,
  ) => Promise<TranscriptSegment[]>
  runLiveRecordingStopSequence: (
    input: LiveRecordingStopSequenceInput,
  ) => Promise<LiveRecordingStopSequenceResult>
  beginGracefulStopLifecycle: (
    setLifecycleState: (state: LiveLifecycleState) => void,
    scheduleDeferred?: (callback: () => void) => number | void,
  ) => void
  resolveFreshRealtimeMeetingId: (meeting: {
    id?: unknown
    existingMeetingId?: unknown
    duplicate?: unknown
  }) => number
  shouldAttemptRealtimeFinalAudioFallback: (input: RealtimeFinalAudioFallbackInput) => boolean
  buildFinalAudioBlobReadyLogPayload: (
    meetingId: number | null,
    bytes: number,
  ) => { meetingId: number | null; bytes: number }
  resolveTranscriptPartialState: (input: {
    stopIncomplete: boolean
    resetRequired?: boolean
    statusMessage?: string | null
  }) => boolean
  isCurrentLiveRecordingSession: (
    completedSessionId: number,
    completedMeetingId: number | null,
    currentSessionId: number,
    currentMeetingId: number | null,
  ) => boolean
}

export type RealtimeAnalysisHelpers = {
  getRealtimeAnalysisFailureMessage: (metadata: AiAnalysis | null, fallback?: string) => string
  metadataFromAnalysisError: (meetingId: number, error: ApiError) => AiAnalysis
  hasStructuredAnalysisData: (analysis: AiAnalysis | null) => boolean
  getAnalysisStatusValue: (analysis: AiAnalysis | null) => string
  isFailedAnalysisStatus: (status: string) => boolean
}

export type UseRealtimeSessionInput = {
  audioRecorder: AudioRecorderLike
  realtimeStream: RealtimeStreamLike
  dualStreamActive: boolean
  selectedDomainMode: DomainMode
  selectedSubjectId?: number | null
  selectedRealtimeLanguage: RealtimeLanguage
  selectedRecordingSource: RecordingSource
  selectedRecordingSourceRef: MutableRefObject<RecordingSource>
  joinMeetingIdInput: string
  liveLifecycleState: LiveLifecycleState
  liveAnalysisMetadata: AiAnalysis | null
  activeRealtimeSessionTokenRef: MutableRefObject<RealtimeSessionToken | null>
  liveMeetingIdRef: MutableRefObject<number | null>
  liveRecordingSessionIdRef: MutableRefObject<number>
  realtimeAttemptIdRef: MutableRefObject<number>
  hydrationRunIdRef: MutableRefObject<number>
  analysisPollRunIdRef: MutableRefObject<number>
  liveTinyChunkStreakRef: MutableRefObject<number>
  liveAnalysisAbortControllerRef: MutableRefObject<AbortController | null>
  handleDualChunkReadyRef: MutableRefObject<
    (chunk: Blob, streamId: DualTabMicStreamId, sessionId: number) => void
  >
  navigateFeatureScene: (scene: DashboardScene) => void
  setActiveRealtimeSessionToken: Dispatch<SetStateAction<RealtimeSessionToken | null>>
  setLiveMeetingId: Dispatch<SetStateAction<number | null>>
  setLiveError: Dispatch<SetStateAction<string | null>>
  setLiveErrorCode: Dispatch<SetStateAction<string | null>>
  setLivePartialWarning: Dispatch<SetStateAction<string | null>>
  setLiveStatusMessage: Dispatch<SetStateAction<string | null>>
  setLiveAnalysis: Dispatch<SetStateAction<AiAnalysis | null>>
  setLiveAnalysisMetadata: Dispatch<SetStateAction<AiAnalysis | null>>
  setLiveAnalysisStatus: Dispatch<SetStateAction<LiveAnalysisStatus>>
  setLiveAnalysisError: Dispatch<SetStateAction<string | null>>
  setHydratedLiveTranscriptSegments: Dispatch<SetStateAction<TranscriptSegment[] | null>>
  setLiveLifecycleState: Dispatch<SetStateAction<LiveLifecycleState>>
  setShowJoinOtherMeeting: Dispatch<SetStateAction<boolean>>
  runTerminalAudioCaptureCleanupRef: RunTerminalAudioCaptureCleanupRef
  failedAudioCaptureCleanupKeyRef: MutableRefObject<string | null>
  sessionHelpers: RealtimeSessionHelpers
  analysisHelpers: RealtimeAnalysisHelpers
}

export const useRealtimeSession = ({
  audioRecorder,
  realtimeStream,
  dualStreamActive,
  selectedDomainMode,
  selectedSubjectId = null,
  selectedRealtimeLanguage,
  selectedRecordingSource,
  selectedRecordingSourceRef,
  joinMeetingIdInput,
  liveLifecycleState,
  liveAnalysisMetadata,
  activeRealtimeSessionTokenRef,
  liveMeetingIdRef,
  liveRecordingSessionIdRef,
  realtimeAttemptIdRef,
  hydrationRunIdRef,
  analysisPollRunIdRef,
  liveTinyChunkStreakRef,
  liveAnalysisAbortControllerRef,
  handleDualChunkReadyRef,
  navigateFeatureScene,
  setActiveRealtimeSessionToken,
  setLiveMeetingId,
  setLiveError,
  setLiveErrorCode,
  setLivePartialWarning,
  setLiveStatusMessage,
  setLiveAnalysis,
  setLiveAnalysisMetadata,
  setLiveAnalysisStatus,
  setLiveAnalysisError,
  setHydratedLiveTranscriptSegments,
  setLiveLifecycleState,
  setShowJoinOtherMeeting,
  runTerminalAudioCaptureCleanupRef,
  failedAudioCaptureCleanupKeyRef,
  sessionHelpers,
  analysisHelpers,
}: UseRealtimeSessionInput) => {
  const {
    pollRealtimeAnalysisAfterStop,
    hydrateLiveTranscriptSegments,
    runLiveRecordingStopSequence,
    beginGracefulStopLifecycle,
    resolveFreshRealtimeMeetingId,
    shouldAttemptRealtimeFinalAudioFallback,
    buildFinalAudioBlobReadyLogPayload,
    resolveTranscriptPartialState,
    isCurrentLiveRecordingSession,
  } = sessionHelpers

  const {
    getRealtimeAnalysisFailureMessage,
    metadataFromAnalysisError,
    hasStructuredAnalysisData,
    getAnalysisStatusValue,
    isFailedAnalysisStatus,
  } = analysisHelpers

  const isCurrentRealtimeSessionToken = useCallback((candidate: RealtimeSessionToken | null): boolean => {
    const active = activeRealtimeSessionTokenRef.current
    if (!candidate || !active) {
      return false
    }

    return (
      candidate.meetingId === active.meetingId
      && candidate.recordingSessionId === active.recordingSessionId
      && candidate.attemptId === active.attemptId
      && candidate.connectionSeq === active.connectionSeq
    )
  }, [activeRealtimeSessionTokenRef])

  const activateRealtimeSessionToken = useCallback((token: RealtimeSessionToken | null) => {
    hydrationRunIdRef.current += 1
    analysisPollRunIdRef.current += 1
    activeRealtimeSessionTokenRef.current = token
    setActiveRealtimeSessionToken(token)
  }, [
    activeRealtimeSessionTokenRef,
    analysisPollRunIdRef,
    hydrationRunIdRef,
    setActiveRealtimeSessionToken,
  ])

  const isCurrentHydrationRun = useCallback((hydrationRunId: number): boolean => {
    return hydrationRunId === hydrationRunIdRef.current
  }, [hydrationRunIdRef])

  const startRealtimeAnalysisPolling = useCallback((
    meetingId: number,
    sessionId: number,
    sessionToken: RealtimeSessionToken,
  ) => {
    liveAnalysisAbortControllerRef.current?.abort()
    const controller = new AbortController()
    const analysisPollRunId = analysisPollRunIdRef.current + 1
    analysisPollRunIdRef.current = analysisPollRunId
    liveAnalysisAbortControllerRef.current = controller
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(buildLiveAnalysisMetadata(meetingId, 'ANALYZING'))
    setLiveAnalysisStatus('polling')
    setLiveAnalysisError(null)

    void (async () => {
      try {
        const pollResult = await pollRealtimeAnalysisAfterStop(
          meetingId,
          controller.signal,
          getAnalysis,
          REALTIME_ANALYSIS_POLL_MAX_ATTEMPTS,
          {
            sessionToken,
            isSessionActive: isCurrentRealtimeSessionToken,
            analysisPollRunId,
            analysisScope: {
              recordingSessionId: sessionToken.recordingSessionId,
              attemptId: sessionToken.attemptId,
            },
          },
        )
        if (
          analysisPollRunId !== analysisPollRunIdRef.current
          || pollResult.reason === 'stale_session'
          || !isCurrentRealtimeSessionToken(sessionToken)
          || !isCurrentLiveRecordingSession(
            sessionId,
            meetingId,
            liveRecordingSessionIdRef.current,
            liveMeetingIdRef.current,
          )
        ) {
          return
        }

        if (pollResult.reason === 'no_transcript_after_finalize') {
          setLiveLifecycleState('stopped_no_analysis')
          setLiveAnalysis(null)
          setLiveAnalysisMetadata(pollResult.metadata ?? buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS', {
            errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
            transcriptRows: 0,
            finalized: true,
          }))
          setLiveAnalysisStatus('pending')
          setLiveAnalysisError(null)
          return
        }

        if (pollResult.status === 'completed' && pollResult.analysis) {
          setLiveAnalysis(pollResult.analysis)
          setLiveAnalysisMetadata(pollResult.metadata ?? pollResult.analysis)
          setLiveAnalysisStatus('completed')
          setLiveAnalysisError(null)
          return
        }

        if (pollResult.status === 'failed') {
          setLiveAnalysis(null)
          setLiveAnalysisMetadata(pollResult.metadata ?? buildLiveAnalysisMetadata(meetingId, 'FAILED'))
          setLiveAnalysisStatus('failed')
          setLiveAnalysisError(pollResult.reason || 'Analysis failed temporarily. Retry available.')
          return
        }

        setLiveAnalysis(null)
        setLiveAnalysisMetadata(pollResult.metadata ?? buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS'))
        setLiveAnalysisStatus('pending')
        setLiveAnalysisError(null)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        if (
          !isCurrentRealtimeSessionToken(sessionToken)
          || !isCurrentLiveRecordingSession(
            sessionId,
            meetingId,
            liveRecordingSessionIdRef.current,
            liveMeetingIdRef.current,
          )
        ) {
          return
        }
        const metadata = error instanceof ApiError
          ? metadataFromAnalysisError(meetingId, error)
          : buildLiveAnalysisMetadata(meetingId, 'FAILED', {
            errorMessage: error instanceof Error ? error.message : 'Unable to load realtime analysis',
          })
        setLiveAnalysis(null)
        setLiveAnalysisMetadata(metadata)
        setLiveAnalysisStatus('failed')
        setLiveAnalysisError(getRealtimeAnalysisFailureMessage(metadata, error instanceof Error ? error.message : undefined))
      }
    })()
  }, [
    analysisPollRunIdRef,
    getRealtimeAnalysisFailureMessage,
    isCurrentLiveRecordingSession,
    isCurrentRealtimeSessionToken,
    liveAnalysisAbortControllerRef,
    liveMeetingIdRef,
    liveRecordingSessionIdRef,
    metadataFromAnalysisError,
    pollRealtimeAnalysisAfterStop,
    setLiveAnalysis,
    setLiveAnalysisError,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setLiveLifecycleState,
  ])

  const handleJoinMeeting = useCallback(() => {
    const parsedMeetingId = Number(joinMeetingIdInput)
    if (!Number.isFinite(parsedMeetingId) || parsedMeetingId <= 0) {
      setLiveError('Vui lòng nhập Meeting ID hợp lệ')
      return
    }

    setLiveError(null)
    setLivePartialWarning(null)
    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(null)
    setLiveAnalysisStatus('idle')
    setLiveAnalysisError(null)
    setHydratedLiveTranscriptSegments(null)
    realtimeStream.clearQueuedAudio?.()
    realtimeStream.disconnect(activeRealtimeSessionTokenRef.current)
    activateRealtimeSessionToken(null)
    setLiveMeetingId(parsedMeetingId)
    liveMeetingIdRef.current = parsedMeetingId
    liveRecordingSessionIdRef.current = 0
    setLiveLifecycleState('idle')
    setShowJoinOtherMeeting(false)
    navigateFeatureScene('realtime')
  }, [
    activateRealtimeSessionToken,
    activeRealtimeSessionTokenRef,
    joinMeetingIdInput,
    liveAnalysisAbortControllerRef,
    liveMeetingIdRef,
    liveRecordingSessionIdRef,
    navigateFeatureScene,
    realtimeStream,
    setHydratedLiveTranscriptSegments,
    setLiveAnalysis,
    setLiveAnalysisError,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setLiveError,
    setLiveLifecycleState,
    setLiveMeetingId,
    setLivePartialWarning,
    setShowJoinOtherMeeting,
  ])

  const handlePrepareLiveMeeting = useCallback(async (recordingSessionId?: number): Promise<void> => {
    setLiveError(null)
    setLiveErrorCode(null)
    setLivePartialWarning(null)
    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(null)
    setLiveAnalysisStatus('idle')
    setLiveAnalysisError(null)
    setLiveStatusMessage('Đang tạo meeting mới...')
    setHydratedLiveTranscriptSegments(null)
    setLiveLifecycleState('connecting')
    liveTinyChunkStreakRef.current = 0
    realtimeStream.clearQueuedAudio?.()
    realtimeStream.disconnect(activeRealtimeSessionTokenRef.current)
    realtimeStream.clearTranscripts?.()
    realtimeStream.clearKeywords?.()
    setLiveMeetingId(null)
    liveMeetingIdRef.current = null
    const sessionId = recordingSessionId ?? audioRecorder.recordingSessionId + 1
    const attemptId = realtimeAttemptIdRef.current + 1
    realtimeAttemptIdRef.current = attemptId
    let meetingCreated = false
    let sessionToken: RealtimeSessionToken | null = null

    try {
      const resolveRealtimeMeetingTitle = (): string => {
        try {
          const stored = sessionStorage.getItem(REALTIME_MEET_CAPTURE_TITLE_KEY)?.trim()
          if (stored) {
            sessionStorage.removeItem(REALTIME_MEET_CAPTURE_TITLE_KEY)
            return stored
          }
        } catch {
          // ignore storage errors
        }
        return 'Live recording session'
      }
      const meeting = await createRealtimeMeeting({
        title: resolveRealtimeMeetingTitle(),
        language: selectedRealtimeLanguage,
        subjectId: selectedSubjectId,
      })
      const normalizedMeetingId = resolveFreshRealtimeMeetingId(meeting)
      if (!Number.isFinite(normalizedMeetingId)) {
        throw new Error('Meeting ID trả về không hợp lệ')
      }

      if (realtimeAttemptIdRef.current !== attemptId) {
        realtimeInfo('[Realtime] STALE_SESSION_PREPARE_IGNORED', {
          meetingId: normalizedMeetingId,
          attemptId,
          recordingSessionId: sessionId,
        })
        throw new Error('Stale realtime session prepare ignored')
      }

      sessionToken = {
        meetingId: normalizedMeetingId,
        recordingSessionId: sessionId,
        attemptId,
        connectionSeq: 0,
      }
      liveRecordingSessionIdRef.current = sessionId
      setLiveMeetingId(normalizedMeetingId)
      liveMeetingIdRef.current = normalizedMeetingId
      activateRealtimeSessionToken(sessionToken)
      meetingCreated = true
      realtimeInfo('[Realtime] REALTIME_START', {
        meetingId: normalizedMeetingId,
        sessionId,
        language: selectedRealtimeLanguage,
        source: selectedRecordingSourceRef.current,
      })
      if (isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
        realtimeInfo('[Realtime]', BROWSER_TAB_CAPTURE_TELEMETRY.REALTIME_STARTED, {
          meetingId: normalizedMeetingId,
          source: selectedRecordingSourceRef.current,
        })
      }
      setLiveStatusMessage(`Meeting ${normalizedMeetingId} đang kết nối realtime...`)

      await realtimeStream.waitForSessionReady(undefined, normalizedMeetingId, sessionToken)

      if (
        !isCurrentRealtimeSessionToken(sessionToken)
        || liveRecordingSessionIdRef.current !== sessionId
        || liveMeetingIdRef.current !== normalizedMeetingId
      ) {
        throw new Error('Stale realtime session prepare ignored')
      }

      setLiveStatusMessage(`Meeting ${normalizedMeetingId} sẵn sàng ghi âm`)
      if (dualStreamActive && audioRecorder.getActiveStreamIds) {
        realtimeStream.configureDualStreams?.(audioRecorder.getActiveStreamIds())
      }
    } catch (error) {
      if (sessionToken !== null && !isCurrentRealtimeSessionToken(sessionToken)) {
        realtimeInfo('[Realtime] STALE_SESSION_PREPARE_IGNORED', {
          meetingId: liveMeetingIdRef.current,
          attemptId,
          recordingSessionId: sessionId,
        })
        throw error instanceof Error ? error : new Error('Stale realtime session prepare ignored')
      }

      const message = error instanceof Error ? error.message : 'Không thể tạo meeting mới'
      setLiveError(message)
      setLiveStatusMessage(null)
      setLiveLifecycleState('error')
      audioRecorder.abortRecording()
      if (meetingCreated) {
        realtimeStream.clearQueuedAudio?.()
        realtimeStream.disconnect(sessionToken)
        setLiveMeetingId(null)
        liveMeetingIdRef.current = null
      }
      liveRecordingSessionIdRef.current = 0
      throw error
    }
  }, [
    activateRealtimeSessionToken,
    activeRealtimeSessionTokenRef,
    audioRecorder,
    dualStreamActive,
    isCurrentRealtimeSessionToken,
    liveAnalysisAbortControllerRef,
    liveMeetingIdRef,
    liveRecordingSessionIdRef,
    liveTinyChunkStreakRef,
    realtimeAttemptIdRef,
    realtimeStream,
    resolveFreshRealtimeMeetingId,
    selectedDomainMode,
    selectedRealtimeLanguage,
    selectedRecordingSourceRef,
    setHydratedLiveTranscriptSegments,
    setLiveAnalysis,
    setLiveAnalysisError,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setLiveError,
    setLiveErrorCode,
    setLiveLifecycleState,
    setLiveMeetingId,
    setLivePartialWarning,
    setLiveStatusMessage,
  ])

  const handleLiveChunkReady = useCallback(async (
    chunk: Blob,
    sessionId: number,
    streamId?: RealtimeAudioStreamId,
  ) => {
    const activeToken = activeRealtimeSessionTokenRef.current
    const activeMeetingId = liveMeetingIdRef.current
    if (!activeMeetingId || sessionId !== liveRecordingSessionIdRef.current || !activeToken) {
      if (!activeMeetingId) {
        realtimeError('[Realtime] STARTUP_INVARIANT_BROKEN', {
          reason: 'chunk_received_without_active_meeting',
          sessionId,
          activeSessionId: liveRecordingSessionIdRef.current,
        })
      }
      realtimeWarn('[Realtime] REALTIME_DROP_STALE_CHUNK', {
        currentMeetingId: activeMeetingId,
        sessionId,
        activeSessionId: liveRecordingSessionIdRef.current,
      })
      return
    }

    if (!isCurrentRealtimeSessionToken(activeToken)) {
      realtimeWarn('[Realtime] REALTIME_DROP_STALE_CHUNK', {
        currentMeetingId: activeMeetingId,
        sessionId,
        activeSessionId: liveRecordingSessionIdRef.current,
        reason: 'stale_session_token',
      })
      return
    }

    if (
      isTerminalAudioCaptureAttempt(failedAudioCaptureCleanupKeyRef, activeToken, activeMeetingId)
    ) {
      return
    }

    const chunkBytes = chunk.size
    const recordingDurationSec = audioRecorder.duration
    const isTabCaptureSource = isBrowserTabRecordingSource(selectedRecordingSourceRef.current)
    const validateMicTinyChunks = streamId === 'mic' || (!streamId && !isTabCaptureSource)
    const currentRms = audioRecorder.getCurrentRms()
    const isTinyChunk = chunkBytes > 0 && chunkBytes < REALTIME_TINY_CHUNK_MAX_BYTES
    // null RMS means "unavailable", not silent — only measured low RMS counts as silence.
    const isSilentCapture = typeof currentRms === 'number' && currentRms <= REALTIME_TINY_CHUNK_MAX_RMS
    if (validateMicTinyChunks && isTinyChunk && isSilentCapture) {
      liveTinyChunkStreakRef.current += 1
    } else if (chunkBytes >= REALTIME_TINY_CHUNK_MAX_BYTES || (validateMicTinyChunks && typeof currentRms === 'number' && !isSilentCapture)) {
      liveTinyChunkStreakRef.current = 0
    } else if (validateMicTinyChunks && currentRms === null) {
      realtimeWarn('[Realtime] REALTIME_RMS_UNAVAILABLE', {
        meetingId: activeMeetingId,
        sessionId,
        chunkBytes,
      })
    }

    if (
      validateMicTinyChunks
      && recordingDurationSec >= REALTIME_TINY_CHUNK_MIN_RECORDING_SEC
      && liveTinyChunkStreakRef.current >= REALTIME_TINY_CHUNK_STREAK_THRESHOLD
    ) {
      const captureError = getRecordingSourceTinyChunkError(selectedRecordingSourceRef.current)
      const cleaned = runTerminalAudioCaptureCleanupRef.current({
        expectedToken: activeToken,
        requireRecorderActive: true,
        errorMessage: captureError,
        statusMessage: 'Không nhận được âm thanh hợp lệ',
        partialWarning: captureError,
        logEvent: '[Realtime] REALTIME_TINY_CHUNK_STREAK_CLIENT',
        logDetails: {
          meetingId: activeMeetingId,
          sessionId,
          streak: liveTinyChunkStreakRef.current,
          chunkBytes,
          rms: currentRms,
          recordingDurationSec,
        },
      })
      if (cleaned) {
        return
      }
    }

    try {
      await realtimeStream.sendAudioChunk(chunk, String(activeMeetingId), streamId)
    } catch (error) {
      realtimeError('Failed to send audio chunk:', error)
      setLiveError(error instanceof Error ? error.message : 'Không thể gửi audio chunk')
      setLiveLifecycleState('error')
    }
  }, [
    activeRealtimeSessionTokenRef,
    audioRecorder,
    failedAudioCaptureCleanupKeyRef,
    isCurrentRealtimeSessionToken,
    liveMeetingIdRef,
    liveRecordingSessionIdRef,
    liveTinyChunkStreakRef,
    realtimeStream,
    runTerminalAudioCaptureCleanupRef,
    selectedRecordingSourceRef,
    setLiveError,
    setLiveLifecycleState,
  ])

  const handleLiveAnalysisRetry = useCallback(async () => {
    const meetingId = liveMeetingIdRef.current
    if (meetingId === null) {
      return
    }
    if (
      isNoTranscriptTerminalLifecycle(liveLifecycleState)
      || liveAnalysisMetadata?.errorCode === 'NO_TRANSCRIPT_AFTER_FINALIZE'
    ) {
      setLiveAnalysisError(null)
      return
    }

    const retryAfterSeconds = liveAnalysisMetadata?.retryAfterSeconds ?? 0
    if (retryAfterSeconds > 0) {
      setLiveAnalysisError(`Retry available after ${retryAfterSeconds}s.`)
      return
    }

    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(buildLiveAnalysisMetadata(meetingId, 'ANALYZING'))
    setLiveAnalysisStatus('polling')
    setLiveAnalysisError(null)

    try {
      const response = await reanalyzeMeetingAnalysis(meetingId, {
        mode: 'force',
        reason: 'manual_reanalyze',
        domainMode: selectedDomainMode,
      })
      const responseStatus = getAnalysisStatusValue(response)
      setLiveAnalysisMetadata(response)

      if (hasStructuredAnalysisData(response)) {
        setLiveAnalysis(response)
        setLiveAnalysisStatus('completed')
        setLiveAnalysisError(null)
        return
      }

      if (isFailedAnalysisStatus(responseStatus)) {
        setLiveAnalysis(null)
        setLiveAnalysisStatus('failed')
        setLiveAnalysisError(getRealtimeAnalysisFailureMessage(response))
        return
      }

      setLiveAnalysis(null)
      setLiveAnalysisStatus('pending')
      setLiveAnalysisError(null)
    } catch (error) {
      const metadata = error instanceof ApiError
        ? metadataFromAnalysisError(meetingId, error)
        : buildLiveAnalysisMetadata(meetingId, 'FAILED', {
          errorMessage: error instanceof Error ? error.message : 'Unable to retry realtime analysis',
        })
      setLiveAnalysis(null)
      setLiveAnalysisMetadata(metadata)
      setLiveAnalysisStatus('failed')
      setLiveAnalysisError(getRealtimeAnalysisFailureMessage(metadata, error instanceof Error ? error.message : undefined))
    }
  }, [
    getAnalysisStatusValue,
    getRealtimeAnalysisFailureMessage,
    hasStructuredAnalysisData,
    isFailedAnalysisStatus,
    liveAnalysisAbortControllerRef,
    liveAnalysisMetadata?.errorCode,
    liveAnalysisMetadata?.retryAfterSeconds,
    liveLifecycleState,
    liveMeetingIdRef,
    metadataFromAnalysisError,
    selectedDomainMode,
    setLiveAnalysis,
    setLiveAnalysisError,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
  ])

  const handleLiveRecordingComplete = useCallback(async (
    fullAudio: Blob,
    sessionId: number,
    recordedMeta?: { mimeType: string; extension: 'webm' | 'm4a' },
  ) => {
    const sessionToken = activeRealtimeSessionTokenRef.current
    const completedMeetingId = liveMeetingIdRef.current
    let noTranscriptAfterFinalize = false
    let terminalAudioCaptureFailure = false
    const isCurrentCompletion = (): boolean => (
      Boolean(sessionToken)
      && isCurrentRealtimeSessionToken(sessionToken)
      && isCurrentLiveRecordingSession(
        sessionId,
        completedMeetingId,
        liveRecordingSessionIdRef.current,
        liveMeetingIdRef.current,
      )
    )
    if (!sessionToken || !isCurrentCompletion()) {
      realtimeWarn('[Realtime] REALTIME_DROP_STALE_CHUNK', {
        currentMeetingId: completedMeetingId,
        sessionId,
        activeSessionId: liveRecordingSessionIdRef.current,
      })
      return
    }

    setLiveStatusMessage(`Đã ghi âm ${Math.max(1, Math.round(fullAudio.size / 1024))} KB`)
    realtimeInfo('[Realtime] FINAL_AUDIO_BLOB_READY', buildFinalAudioBlobReadyLogPayload(completedMeetingId, fullAudio.size))
    try {
      if (!isCurrentCompletion()) {
        realtimeInfo('[Realtime] STALE_SESSION_COMPLETE_IGNORED', {
          meetingId: completedMeetingId,
          sessionId,
        })
        return
      }

      const stopResult = await runLiveRecordingStopSequence({
        meetingId: completedMeetingId,
        sessionId,
        stopStream: realtimeStream.stopStream
          ? () => realtimeStream.stopStream!()
          : undefined,
        setLifecycleState: setLiveLifecycleState,
        isCurrentAttempt: isCurrentCompletion,
      })
      if (stopResult.stale || !isCurrentCompletion()) {
        realtimeInfo('[Realtime] STALE_SESSION_COMPLETE_IGNORED', {
          meetingId: completedMeetingId,
          sessionId,
          phase: 'after_stop_sequence',
          stale: Boolean(stopResult.stale),
        })
        return
      }
      const { stopIncomplete } = stopResult
      if (stopIncomplete) {
        realtimeWarn('[Realtime] STREAM_STOP_INCOMPLETE_DISCONNECT_FALLBACK', {
          meetingId: completedMeetingId,
          sessionId,
        })
        realtimeStream.disconnect(sessionToken)
        await new Promise((resolve) => setTimeout(resolve, STREAM_STOP_DISCONNECT_FALLBACK_DELAY_MS))
        if (!isCurrentCompletion()) {
          realtimeInfo('[Realtime] STALE_SESSION_COMPLETE_IGNORED', {
            meetingId: completedMeetingId,
            sessionId,
            phase: 'after_stop_incomplete_delay',
          })
          return
        }
      }

      const activeMeetingId = liveMeetingIdRef.current
      if (activeMeetingId) {
        const hydrationRunId = hydrationRunIdRef.current + 1
        hydrationRunIdRef.current = hydrationRunId
        const partialState = resolveTranscriptPartialState({
          stopIncomplete,
          resetRequired: Boolean(realtimeStream.status.resetRequired),
          statusMessage: realtimeStream.status.message,
        })
        const liveSnapshot = [...realtimeStream.transcripts]
        const hydratedSegments = await hydrateLiveTranscriptSegments(
          activeMeetingId,
          getTranscript,
          sessionToken,
          isCurrentRealtimeSessionToken,
          {
            backendPartial: partialState,
            backendResetRequired: realtimeStream.status.resetRequired,
            currentLiveSegments: liveSnapshot,
            hydrationRunId,
            isHydrationRunActive: isCurrentHydrationRun,
          },
        )
        if (!isCurrentHydrationRun(hydrationRunId) || !isCurrentCompletion()) {
          return
        }
        const mergedHydration = mergeHydratedTranscriptWithLive(liveSnapshot, hydratedSegments)
        setHydratedLiveTranscriptSegments(mergedHydration)
        if (mergedHydration.length === 0) {
          noTranscriptAfterFinalize = true
        }
        const shouldAttemptFinalAudioFallback = shouldAttemptRealtimeFinalAudioFallback({
          mergedTranscriptCount: mergedHydration.length,
          fullAudioBytes: fullAudio.size,
          minFallbackAudioBytes: REALTIME_MIN_FALLBACK_AUDIO_BYTES,
          stopIncomplete,
          partialState,
          resetRequired: Boolean(realtimeStream.status.resetRequired),
          streamState: realtimeStream.status.state ?? 'stopped',
        })
        if (shouldAttemptFinalAudioFallback) {
          setLiveStatusMessage('Đang thử chuyển sang nhận dạng giọng nói dự phòng...')
          realtimeInfo('[Realtime] REALTIME_FINAL_AUDIO_FALLBACK_REQUESTED', {
            meetingId: activeMeetingId,
            sessionId,
            audioBytes: fullAudio.size,
            stopIncomplete,
            partialState,
            resetRequired: realtimeStream.status.resetRequired,
          })
          try {
            const fallbackExtension = recordedMeta?.extension
              || (fullAudio.type.toLowerCase().includes('mp4') ? 'm4a' : 'webm')
            const fallbackMime = recordedMeta?.mimeType || fullAudio.type || 'audio/webm'
            const fallbackFile = new File(
              [fullAudio],
              `realtime-fallback-${activeMeetingId}.${fallbackExtension}`,
              { type: fallbackMime },
            )
            const fallbackResponse = await submitRealtimeFinalAudioFallback(
              activeMeetingId,
              fallbackFile,
              selectedRealtimeLanguage,
            )
            if (!isCurrentCompletion()) {
              realtimeInfo('[Realtime] STALE_SESSION_COMPLETE_IGNORED', {
                meetingId: completedMeetingId,
                sessionId,
                phase: 'after_final_audio_fallback',
              })
              return
            }
            const fallbackRows = Number(
              fallbackResponse.transcriptRows ?? fallbackResponse.transcript_count ?? 0,
            )
            if (fallbackRows > 0) {
              noTranscriptAfterFinalize = false
              const fallbackTranscript = sessionToken
                ? await getTranscript(activeMeetingId, {
                    recordingSessionId: sessionToken.recordingSessionId,
                    attemptId: sessionToken.attemptId,
                  })
                : await getTranscript(activeMeetingId)
              if (!isCurrentCompletion()) {
                realtimeInfo('[Realtime] STALE_SESSION_COMPLETE_IGNORED', {
                  meetingId: completedMeetingId,
                  sessionId,
                  phase: 'after_fallback_transcript',
                })
                return
              }
              const fallbackSegments = mergeTranscriptSegments(
                normalizePersistedTranscriptSegments(fallbackTranscript.transcripts || []),
              )
              setHydratedLiveTranscriptSegments(fallbackSegments)
              setLivePartialWarning(null)
              setLiveStatusMessage('Đã nhận dạng transcript từ audio dự phòng')
              realtimeInfo('[Realtime] REALTIME_FINAL_AUDIO_FALLBACK_SUCCEEDED', {
                meetingId: activeMeetingId,
                sessionId,
                transcriptRows: fallbackRows,
              })
            } else {
              const fallbackStatus = String(fallbackResponse.status ?? fallbackResponse.errorCode ?? 'NO_TRANSCRIPT')
              if (fallbackStatus === 'FAILED_AUDIO_CAPTURE') {
                const cleaned = runTerminalAudioCaptureCleanupRef.current({
                  expectedToken: sessionToken,
                  errorMessage: 'Không nhận được âm thanh hợp lệ để nhận dạng.',
                  statusMessage: 'Không nhận được âm thanh hợp lệ',
                  partialWarning: 'Không nhận được âm thanh hợp lệ để nhận dạng.',
                  transcriptRows: fallbackRows,
                  logEvent: '[Realtime] REALTIME_FINAL_AUDIO_FALLBACK_FAILED_AUDIO_CAPTURE',
                  logDetails: {
                    meetingId: activeMeetingId,
                    sessionId,
                    transcriptRows: fallbackRows,
                    status: fallbackStatus,
                  },
                })
                if (cleaned) {
                  terminalAudioCaptureFailure = true
                  noTranscriptAfterFinalize = false
                }
              } else if (fallbackStatus === 'FINAL_AUDIO_FALLBACK_UNAVAILABLE') {
                setLivePartialWarning('Transcript đã lưu nhưng không thể khôi phục phần đuôi từ audio fallback (WebM continuation không khả dụng).')
                realtimeInfo('[Realtime] REALTIME_FINAL_AUDIO_TAIL_RECOVERY_UNAVAILABLE', {
                  meetingId: activeMeetingId,
                  sessionId,
                  persistedTranscriptRows: mergedHydration.length,
                })
              }
              realtimeInfo('[Realtime] REALTIME_FINAL_AUDIO_FALLBACK_EMPTY', {
                meetingId: activeMeetingId,
                sessionId,
                status: fallbackStatus,
              })
            }
          } catch (fallbackError) {
            if (!isCurrentCompletion()) {
              return
            }
            realtimeWarn('[Realtime] REALTIME_FINAL_AUDIO_FALLBACK_FAILED', {
              meetingId: activeMeetingId,
              sessionId,
              error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            })
          }
        }
        if (!isCurrentCompletion()) {
          return
        }
        if (noTranscriptAfterFinalize && !terminalAudioCaptureFailure) {
          liveAnalysisAbortControllerRef.current?.abort()
          liveAnalysisAbortControllerRef.current = null
          analysisPollRunIdRef.current += 1
          setLiveLifecycleState('no_transcript_after_finalize')
          setLivePartialWarning('Chưa có transcript')
          setLiveStatusMessage('Đã dừng ghi âm (chưa có transcript)')
          setLiveAnalysis(null)
          setLiveAnalysisMetadata(buildLiveAnalysisMetadata(activeMeetingId, 'NO_ANALYSIS', {
            errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
            transcriptRows: 0,
            finalized: true,
          }))
          setLiveAnalysisStatus('pending')
          setLiveAnalysisError(null)
        }
        if (partialState && !noTranscriptAfterFinalize && !terminalAudioCaptureFailure) {
          setLivePartialWarning('Transcript có thể chưa đầy đủ')
          realtimeInfo('[Realtime] TRANSCRIPT_PARTIAL_WARNING', {
            meetingId: activeMeetingId,
            fragments: hydratedSegments.length,
          })
        }
      } else {
        if (!isCurrentCompletion()) {
          return
        }
        setHydratedLiveTranscriptSegments([])
      }

      if (!isCurrentCompletion()) {
        return
      }

      if (realtimeStream.disconnect && !terminalAudioCaptureFailure) {
        realtimeStream.disconnect(sessionToken)
      }

      if (terminalAudioCaptureFailure) {
        realtimeInfo('[Realtime] REALTIME_CLEANUP_DONE', {
          meetingId: liveMeetingIdRef.current,
          sessionId,
          terminalAudioCaptureFailure: true,
        })
        audioRecorder.cleanupRecordingResources()
        return
      }

      if (noTranscriptAfterFinalize) {
        setLiveLifecycleState('stopped_no_analysis')
      } else {
        setLiveLifecycleState('stopped')
      }
      setLiveError(null)
      if (!noTranscriptAfterFinalize) {
        setLiveStatusMessage('Đã dừng ghi âm')
      }
      if (completedMeetingId !== null && !noTranscriptAfterFinalize) {
        startRealtimeAnalysisPolling(completedMeetingId, sessionId, sessionToken)
      }

      realtimeInfo('[Realtime] REALTIME_CLEANUP_DONE', {
        meetingId: liveMeetingIdRef.current,
        sessionId,
      })
      audioRecorder.cleanupRecordingResources()
    } catch (err) {
      if (!isCurrentCompletion()) {
        realtimeInfo('[Realtime] STALE_HYDRATION_IGNORED', {
          meetingId: completedMeetingId,
          sessionId,
        })
        return
      }

      realtimeError('Error during finalization after recording stop:', err)
      setHydratedLiveTranscriptSegments([])
      setLiveLifecycleState('error')
    }
  }, [
    activeRealtimeSessionTokenRef,
    analysisPollRunIdRef,
    audioRecorder,
    buildFinalAudioBlobReadyLogPayload,
    hydrateLiveTranscriptSegments,
    hydrationRunIdRef,
    isCurrentHydrationRun,
    isCurrentLiveRecordingSession,
    isCurrentRealtimeSessionToken,
    liveAnalysisAbortControllerRef,
    liveMeetingIdRef,
    liveRecordingSessionIdRef,
    realtimeStream,
    resolveTranscriptPartialState,
    runLiveRecordingStopSequence,
    runTerminalAudioCaptureCleanupRef,
    selectedRealtimeLanguage,
    setHydratedLiveTranscriptSegments,
    setLiveAnalysis,
    setLiveAnalysisError,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setLiveError,
    setLiveLifecycleState,
    setLivePartialWarning,
    setLiveStatusMessage,
    shouldAttemptRealtimeFinalAudioFallback,
    startRealtimeAnalysisPolling,
  ])

  const handleStopRequested = useCallback(() => {
    realtimeInfo('[Realtime] REALTIME_STOP_REQUESTED', {
      meetingId: liveMeetingIdRef.current,
      source: selectedRecordingSource,
      phase: 'recorder_stop',
    })
    beginGracefulStopLifecycle(setLiveLifecycleState)
  }, [
    beginGracefulStopLifecycle,
    liveMeetingIdRef,
    selectedRecordingSource,
    setLiveLifecycleState,
  ])

  useEffect(() => {
    handleDualChunkReadyRef.current = (chunk, streamId, sessionId) => {
      void handleLiveChunkReady(chunk, sessionId, streamId)
    }
  }, [handleDualChunkReadyRef, handleLiveChunkReady])

  return {
    activateRealtimeSessionToken,
    handlePrepareLiveMeeting,
    handleLiveChunkReady,
    handleLiveRecordingComplete,
    handleLiveAnalysisRetry,
    handleJoinMeeting,
    handleStopRequested,
    startRealtimeAnalysisPolling,
  }
}
