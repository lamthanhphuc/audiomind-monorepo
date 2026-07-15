import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { RealtimeSessionToken } from '../hooks/useRealtimeMeetingStream'
import type { AiAnalysis } from '../types'
import { buildLiveAnalysisMetadata } from './liveAnalysisMetadata'
import type { LiveLifecycleState } from './liveLifecycle'
import { realtimeWarn } from '../utils/realtimeTelemetry'

type LiveAnalysisStatus = 'idle' | 'polling' | 'completed' | 'pending' | 'failed'

type AudioRecorderLike = {
  state: string
  abortRecording: () => void
}

type RealtimeStreamLike = {
  clearQueuedAudio?: () => void
  disconnect: (
    token: RealtimeSessionToken | null,
    options?: { reason?: 'user' | 'audio_capture_failure' | 'default' },
  ) => void
}

export const sessionAttemptKey = (
  token: RealtimeSessionToken | null,
  meetingId: number | null,
): string | null => {
  if (token) {
    return `${token.meetingId}:${token.recordingSessionId}:${token.attemptId}:${token.connectionSeq}`
  }
  if (meetingId === null) {
    return null
  }
  return `meeting:${meetingId}`
}

export const isSameSessionToken = (
  left: RealtimeSessionToken | null | undefined,
  right: RealtimeSessionToken | null | undefined,
): boolean => {
  if (!left || !right) {
    return false
  }
  return (
    left.meetingId === right.meetingId
    && left.recordingSessionId === right.recordingSessionId
    && left.attemptId === right.attemptId
    && left.connectionSeq === right.connectionSeq
  )
}

export type TerminalAudioCaptureCleanupInput = {
  /** Token/attempt that owns this failure; ignore if active session has moved on. */
  expectedToken?: RealtimeSessionToken | null
  errorMessage: string
  statusMessage: string
  partialWarning: string
  requireRecorderActive?: boolean
  logEvent?: string
  logDetails?: Record<string, unknown>
  transcriptRows?: number
}

export type TerminalAudioCaptureCleanupRunnerDeps = {
  failedAudioCaptureCleanupKeyRef: MutableRefObject<string | null>
  activeRealtimeSessionTokenRef: MutableRefObject<RealtimeSessionToken | null>
  liveMeetingIdRef: MutableRefObject<number | null>
  liveAnalysisAbortControllerRef: MutableRefObject<AbortController | null>
  analysisPollRunIdRef: MutableRefObject<number>
  audioRecorderRef: MutableRefObject<AudioRecorderLike>
  realtimeStreamRef: MutableRefObject<RealtimeStreamLike>
  setLiveLifecycleState: Dispatch<SetStateAction<LiveLifecycleState>>
  setLiveError: Dispatch<SetStateAction<string | null>>
  setLiveAnalysis: Dispatch<SetStateAction<AiAnalysis | null>>
  setLiveAnalysisMetadata: Dispatch<SetStateAction<AiAnalysis | null>>
  setLiveAnalysisStatus: Dispatch<SetStateAction<LiveAnalysisStatus>>
  setLiveAnalysisError: Dispatch<SetStateAction<string | null>>
  setLivePartialWarning: Dispatch<SetStateAction<string | null>>
  setLiveStatusMessage: Dispatch<SetStateAction<string | null>>
}

export const runTerminalAudioCaptureCleanup = (
  deps: TerminalAudioCaptureCleanupRunnerDeps,
  input: TerminalAudioCaptureCleanupInput,
): boolean => {
  const meetingId = deps.liveMeetingIdRef.current
  if (meetingId === null) {
    return false
  }

  const activeToken = deps.activeRealtimeSessionTokenRef.current
  if (input.expectedToken !== undefined) {
    if (!isSameSessionToken(input.expectedToken, activeToken)) {
      return false
    }
  }

  const ownershipToken = input.expectedToken ?? activeToken
  const cleanupKey = sessionAttemptKey(ownershipToken, meetingId)
  if (!cleanupKey || deps.failedAudioCaptureCleanupKeyRef.current === cleanupKey) {
    return false
  }

  const recorder = deps.audioRecorderRef.current
  if (input.requireRecorderActive) {
    if (
      recorder.state !== 'recording'
      && recorder.state !== 'paused'
      && recorder.state !== 'connecting'
    ) {
      return false
    }
  }

  if (!isSameSessionToken(ownershipToken, deps.activeRealtimeSessionTokenRef.current)
    || deps.liveMeetingIdRef.current !== meetingId) {
    return false
  }

  deps.failedAudioCaptureCleanupKeyRef.current = cleanupKey

  if (input.logEvent) {
    realtimeWarn(input.logEvent, {
      meetingId,
      ...input.logDetails,
    })
  }

  deps.liveAnalysisAbortControllerRef.current?.abort()
  deps.liveAnalysisAbortControllerRef.current = null
  deps.analysisPollRunIdRef.current += 1
  deps.setLiveLifecycleState('failed_audio_capture')
  deps.setLiveError(input.errorMessage)
  deps.setLiveAnalysis(null)
  deps.setLiveAnalysisMetadata(buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS', {
    errorCode: 'FAILED_AUDIO_CAPTURE',
    transcriptRows: input.transcriptRows ?? 0,
    finalized: true,
  }))
  deps.setLiveAnalysisStatus('pending')
  deps.setLiveAnalysisError(null)
  deps.setLivePartialWarning(input.partialWarning)
  deps.setLiveStatusMessage(input.statusMessage)

  if (
    recorder.state === 'recording'
    || recorder.state === 'paused'
    || recorder.state === 'connecting'
  ) {
    recorder.abortRecording()
  }

  const stream = deps.realtimeStreamRef.current
  stream.clearQueuedAudio?.()
  if (ownershipToken && isSameSessionToken(ownershipToken, deps.activeRealtimeSessionTokenRef.current)) {
    stream.disconnect(ownershipToken, { reason: 'audio_capture_failure' })
  }
  return true
}

export const isTerminalAudioCaptureAttempt = (
  failedAudioCaptureCleanupKeyRef: MutableRefObject<string | null>,
  token: RealtimeSessionToken | null,
  meetingId: number | null,
): boolean => {
  const attemptKey = sessionAttemptKey(token, meetingId)
  return attemptKey !== null && failedAudioCaptureCleanupKeyRef.current === attemptKey
}
