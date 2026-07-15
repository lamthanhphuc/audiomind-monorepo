import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { RealtimeSessionToken } from '../hooks/useRealtimeMeetingStream'
import {
  runTerminalAudioCaptureCleanup,
  type TerminalAudioCaptureCleanupInput,
  type TerminalAudioCaptureCleanupRunnerDeps,
} from './terminalAudioCaptureCleanup'
import type { Dispatch, SetStateAction } from 'react'
import type { AiAnalysis } from '../types'
import type { LiveLifecycleState } from './liveLifecycle'

type LiveAnalysisStatus = 'idle' | 'polling' | 'completed' | 'pending' | 'failed'

type AudioRecorderLike = TerminalAudioCaptureCleanupRunnerDeps['audioRecorderRef']['current']

type RealtimeStreamLike = TerminalAudioCaptureCleanupRunnerDeps['realtimeStreamRef']['current']

export type UseTerminalAudioCaptureCleanupInput = {
  audioRecorder: AudioRecorderLike
  realtimeStream: RealtimeStreamLike
  activeRealtimeSessionTokenRef: MutableRefObject<RealtimeSessionToken | null>
  liveMeetingIdRef: MutableRefObject<number | null>
  liveAnalysisAbortControllerRef: MutableRefObject<AbortController | null>
  analysisPollRunIdRef: MutableRefObject<number>
  setLiveLifecycleState: Dispatch<SetStateAction<LiveLifecycleState>>
  setLiveError: Dispatch<SetStateAction<string | null>>
  setLiveAnalysis: Dispatch<SetStateAction<AiAnalysis | null>>
  setLiveAnalysisMetadata: Dispatch<SetStateAction<AiAnalysis | null>>
  setLiveAnalysisStatus: Dispatch<SetStateAction<LiveAnalysisStatus>>
  setLiveAnalysisError: Dispatch<SetStateAction<string | null>>
  setLivePartialWarning: Dispatch<SetStateAction<string | null>>
  setLiveStatusMessage: Dispatch<SetStateAction<string | null>>
}

export const useTerminalAudioCaptureCleanup = ({
  audioRecorder,
  realtimeStream,
  activeRealtimeSessionTokenRef,
  liveMeetingIdRef,
  liveAnalysisAbortControllerRef,
  analysisPollRunIdRef,
  setLiveLifecycleState,
  setLiveError,
  setLiveAnalysis,
  setLiveAnalysisMetadata,
  setLiveAnalysisStatus,
  setLiveAnalysisError,
  setLivePartialWarning,
  setLiveStatusMessage,
}: UseTerminalAudioCaptureCleanupInput) => {
  const failedAudioCaptureCleanupKeyRef = useRef<string | null>(null)
  const audioRecorderRef = useRef(audioRecorder)
  const realtimeStreamRef = useRef(realtimeStream)

  useEffect(() => {
    audioRecorderRef.current = audioRecorder
  }, [audioRecorder])

  useEffect(() => {
    realtimeStreamRef.current = realtimeStream
  }, [realtimeStream])

  const runTerminalAudioCaptureCleanupCallback = useCallback((input: TerminalAudioCaptureCleanupInput) => {
    const deps: TerminalAudioCaptureCleanupRunnerDeps = {
      failedAudioCaptureCleanupKeyRef,
      activeRealtimeSessionTokenRef,
      liveMeetingIdRef,
      liveAnalysisAbortControllerRef,
      analysisPollRunIdRef,
      audioRecorderRef,
      realtimeStreamRef,
      setLiveLifecycleState,
      setLiveError,
      setLiveAnalysis,
      setLiveAnalysisMetadata,
      setLiveAnalysisStatus,
      setLiveAnalysisError,
      setLivePartialWarning,
      setLiveStatusMessage,
    }
    return runTerminalAudioCaptureCleanup(deps, input)
  }, [
    activeRealtimeSessionTokenRef,
    analysisPollRunIdRef,
    liveAnalysisAbortControllerRef,
    liveMeetingIdRef,
    setLiveAnalysis,
    setLiveAnalysisError,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setLiveError,
    setLiveLifecycleState,
    setLivePartialWarning,
    setLiveStatusMessage,
  ])

  const runTerminalAudioCaptureCleanupRef = useRef(runTerminalAudioCaptureCleanupCallback)
  useEffect(() => {
    runTerminalAudioCaptureCleanupRef.current = runTerminalAudioCaptureCleanupCallback
  }, [runTerminalAudioCaptureCleanupCallback])

  return {
    failedAudioCaptureCleanupKeyRef,
    runTerminalAudioCaptureCleanup: runTerminalAudioCaptureCleanupCallback,
    runTerminalAudioCaptureCleanupRef,
  }
}

export type RunTerminalAudioCaptureCleanupRef = MutableRefObject<
  (input: TerminalAudioCaptureCleanupInput) => boolean
>
