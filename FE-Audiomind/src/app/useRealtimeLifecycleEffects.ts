import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { AudioRecorderState } from '../hooks/useAudioRecorder'
import {
  normalizeRealtimeLanguage,
  normalizeRealtimeSpeakerMode,
  type RealtimeLanguage,
  type RealtimeSessionToken,
  type RealtimeSpeakerMode,
} from '../hooks/useRealtimeMeetingStream'
import type { VoiceActivityState } from '../hooks/useVoiceActivityDetection'
import {
  isBrowserTabRecordingSource,
  RECORDING_SOURCE_ERRORS,
  type RecordingSource,
} from '../constants/recordingSource'
import {
  REALTIME_NOISE_SUPPRESSION_TOGGLE_ENABLED,
} from '../services/config'
import { buildLiveAnalysisMetadata } from './liveAnalysisMetadata'
import {
  isFailedAudioCaptureLifecycle,
  isNoTranscriptTerminalLifecycle,
  isRealtimeTerminalLifecycle,
  resolveVoiceActivityLifecycleUpdate,
  type LiveLifecycleState,
} from './liveLifecycle'
import { realtimeInfo, realtimeWarn } from '../utils/realtimeTelemetry'
import type { RunTerminalAudioCaptureCleanupRef } from './useTerminalAudioCaptureCleanup'

const LIVE_STATUS_LISTENING = 'Đang lắng nghe...'

type AudioRecorderLike = {
  state: AudioRecorderState
  abortRecording: () => void
  startRecording: () => Promise<number | null>
  getActiveStreamIds?: () => Array<'tab' | 'mic'>
}

type RealtimeStreamLike = {
  status: {
    resetRequired?: boolean
    state?: string
    errorCode?: string
    status?: string
  }
  isAuthenticated: boolean
  clearQueuedAudio?: () => void
  disconnect: (
    token: RealtimeSessionToken | null,
    options?: { reason?: 'user' | 'audio_capture_failure' | 'default' },
  ) => void
  configureDualStreams?: (streamIds: Array<'tab' | 'mic'>) => void
}

type VoiceActivityLike = {
  state: VoiceActivityState
}

export type RealtimeLifecycleEffectsInput = {
  audioRecorder: AudioRecorderLike
  realtimeStream: RealtimeStreamLike
  voiceActivity: VoiceActivityLike
  dualStreamActive: boolean
  selectedRecordingSource: RecordingSource
  selectedRecordingSourceRef: MutableRefObject<RecordingSource>
  selectedRealtimeLanguage: RealtimeLanguage
  selectedRealtimeSpeakerMode: RealtimeSpeakerMode
  selectedMicSensitivity: string
  noiseSuppressionEnabled: boolean
  noiseSuppressionSupported: boolean
  activeRealtimeSessionToken: RealtimeSessionToken | null
  activeRealtimeSessionTokenRef: MutableRefObject<RealtimeSessionToken | null>
  liveLifecycleState: LiveLifecycleState
  liveMeetingIdRef: MutableRefObject<number | null>
  liveAnalysisAbortControllerRef: MutableRefObject<AbortController | null>
  analysisPollRunIdRef: MutableRefObject<number>
  resetRecoveryInProgressRef: MutableRefObject<boolean>
  restartAfterReconnectRef: MutableRefObject<boolean>
  tabTrackEndedFinalizeRef: MutableRefObject<boolean>
  gracefulStopRef: MutableRefObject<(() => Promise<void>) | null>
  lastVoiceActivityStateRef: MutableRefObject<VoiceActivityState | null>
  onTabAudioTrackEndedRef: MutableRefObject<(() => void) | undefined>
  onTabCaptureFailureRef: MutableRefObject<((message: string, reason: 'track' | 'stall') => void) | undefined>
  onTabPipelineStalledRef: MutableRefObject<(() => void) | undefined>
  runTerminalAudioCaptureCleanupRef: RunTerminalAudioCaptureCleanupRef
  setLiveLifecycleState: Dispatch<SetStateAction<LiveLifecycleState>>
  setLiveError: Dispatch<SetStateAction<string | null>>
  setLiveStatusMessage: Dispatch<SetStateAction<string | null>>
  setLivePartialWarning: Dispatch<SetStateAction<string | null>>
  setLiveAnalysis: Dispatch<SetStateAction<import('../types').AiAnalysis | null>>
  setLiveAnalysisMetadata: Dispatch<SetStateAction<import('../types').AiAnalysis | null>>
  setLiveAnalysisStatus: Dispatch<SetStateAction<'idle' | 'polling' | 'completed' | 'pending' | 'failed'>>
  setLiveAnalysisError: Dispatch<SetStateAction<string | null>>
}

export const useRealtimeLifecycleEffects = ({
  audioRecorder,
  realtimeStream,
  voiceActivity,
  dualStreamActive,
  selectedRecordingSource,
  selectedRecordingSourceRef,
  selectedRealtimeLanguage,
  selectedRealtimeSpeakerMode,
  selectedMicSensitivity,
  noiseSuppressionEnabled,
  noiseSuppressionSupported,
  activeRealtimeSessionToken,
  activeRealtimeSessionTokenRef,
  liveLifecycleState,
  liveMeetingIdRef,
  liveAnalysisAbortControllerRef,
  analysisPollRunIdRef,
  resetRecoveryInProgressRef,
  restartAfterReconnectRef,
  tabTrackEndedFinalizeRef,
  gracefulStopRef,
  lastVoiceActivityStateRef,
  onTabAudioTrackEndedRef,
  onTabCaptureFailureRef,
  onTabPipelineStalledRef,
  runTerminalAudioCaptureCleanupRef,
  setLiveLifecycleState,
  setLiveError,
  setLiveStatusMessage,
  setLivePartialWarning,
  setLiveAnalysis,
  setLiveAnalysisMetadata,
  setLiveAnalysisStatus,
  setLiveAnalysisError,
}: RealtimeLifecycleEffectsInput) => {
  const lastLoggedRealtimeLanguageRef = useRef<RealtimeLanguage | null>(null)
  const lastLoggedRealtimeSpeakerModeRef = useRef<RealtimeSpeakerMode | null>(null)
  const audioRecorderRef = useRef(audioRecorder)
  const realtimeStreamRef = useRef(realtimeStream)

  useEffect(() => {
    audioRecorderRef.current = audioRecorder
  }, [audioRecorder])

  useEffect(() => {
    realtimeStreamRef.current = realtimeStream
  }, [realtimeStream])

  useEffect(() => {
    // Capture attempt ownership when installing the callback so a stale closure
    // cannot terminate a newer session/attempt.
    const callbackToken = activeRealtimeSessionToken

    onTabAudioTrackEndedRef.current = () => {
      if (!isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
        return
      }
      if (tabTrackEndedFinalizeRef.current) {
        return
      }
      tabTrackEndedFinalizeRef.current = true
      setLiveStatusMessage(RECORDING_SOURCE_ERRORS.tabStopSharing)
      realtimeInfo('[Realtime] REALTIME_STOP_REQUESTED', {
        meetingId: liveMeetingIdRef.current,
        source: selectedRecordingSourceRef.current,
        reason: 'tab_track_ended',
      })
      void gracefulStopRef.current?.()
    }
    onTabCaptureFailureRef.current = (message, reason) => {
      if (!isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
        return
      }
      runTerminalAudioCaptureCleanupRef.current({
        expectedToken: callbackToken,
        requireRecorderActive: true,
        errorMessage: message,
        statusMessage: 'Lỗi thu âm tab',
        partialWarning: message,
        logEvent: '[Realtime] TAB_AUDIO_CAPTURE_FAILURE',
        logDetails: {
          source: selectedRecordingSourceRef.current,
          reason,
          message,
        },
      })
    }
    onTabPipelineStalledRef.current = () => {
      if (!isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
        return
      }
      const recorder = audioRecorderRef.current
      if (recorder.state !== 'recording' && recorder.state !== 'paused' && recorder.state !== 'connecting') {
        return
      }
      realtimeWarn('[Realtime] TAB_AUDIO_PIPELINE_DEGRADED', {
        meetingId: liveMeetingIdRef.current,
        source: selectedRecordingSourceRef.current,
        reason: 'output_mismatch',
      })
      setLivePartialWarning(RECORDING_SOURCE_ERRORS.tabCaptureStalled)
      setLiveStatusMessage(RECORDING_SOURCE_ERRORS.tabCaptureStalled)
    }
  }, [
    activeRealtimeSessionToken,
    gracefulStopRef,
    liveMeetingIdRef,
    onTabAudioTrackEndedRef,
    onTabCaptureFailureRef,
    onTabPipelineStalledRef,
    selectedRecordingSourceRef,
    setLivePartialWarning,
    setLiveStatusMessage,
    tabTrackEndedFinalizeRef,
  ])

  useEffect(() => {
    realtimeInfo('[Realtime] RECORDING_SOURCE_SELECTED', {
      source: selectedRecordingSource,
      lifecycleState: liveLifecycleState,
    })
  }, [liveLifecycleState, selectedRecordingSource])

  useEffect(() => {
    const normalizedLanguage = normalizeRealtimeLanguage(selectedRealtimeLanguage)
    if (lastLoggedRealtimeLanguageRef.current === normalizedLanguage) {
      return
    }

    lastLoggedRealtimeLanguageRef.current = normalizedLanguage
    realtimeInfo('[Realtime] REALTIME_LANGUAGE_SELECTED', {
      language: normalizedLanguage,
      lifecycleState: liveLifecycleState,
    })
  }, [liveLifecycleState, selectedRealtimeLanguage])

  useEffect(() => {
    const normalizedSpeakerMode = normalizeRealtimeSpeakerMode(selectedRealtimeSpeakerMode)
    if (lastLoggedRealtimeSpeakerModeRef.current === normalizedSpeakerMode) {
      return
    }

    lastLoggedRealtimeSpeakerModeRef.current = normalizedSpeakerMode
    realtimeInfo('[Realtime] FE_REALTIME_SPEAKER_MODE_SELECTED', {
      speakerMode: normalizedSpeakerMode,
      lifecycleState: liveLifecycleState,
    })
  }, [liveLifecycleState, selectedRealtimeSpeakerMode])

  useEffect(() => {
    activeRealtimeSessionTokenRef.current = activeRealtimeSessionToken
  }, [activeRealtimeSessionToken, activeRealtimeSessionTokenRef])

  useEffect(() => {
    realtimeInfo('[Realtime] MIC_SENSITIVITY_CHANGED', {
      mode: selectedMicSensitivity,
    })
  }, [selectedMicSensitivity])

  useEffect(() => {
    realtimeInfo('[Realtime] MIC_NOISE_SUPPRESSION_SELECTED', {
      mode: noiseSuppressionEnabled ? 'on' : 'off',
    })
  }, [noiseSuppressionEnabled])

  useEffect(() => {
    if (REALTIME_NOISE_SUPPRESSION_TOGGLE_ENABLED && !noiseSuppressionSupported) {
      realtimeInfo('[Realtime] MIC_CONSTRAINT_UNSUPPORTED', {
        constraint: 'noiseSuppression',
      })
    }
  }, [noiseSuppressionSupported])

  useEffect(() => {
    if (
      realtimeStream.status.state === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.status === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.errorCode === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.errorCode === 'REALTIME_UNSUPPORTED_RECORDER_FORMAT'
      || isFailedAudioCaptureLifecycle(liveLifecycleState)
    ) {
      return
    }

    if (!realtimeStream.status.resetRequired) {
      resetRecoveryInProgressRef.current = false
      return
    }

    if (resetRecoveryInProgressRef.current) {
      return
    }

    if (audioRecorder.state !== 'recording' && audioRecorder.state !== 'paused') {
      return
    }

    resetRecoveryInProgressRef.current = true
    realtimeInfo('[Realtime] FRONTEND_RESET_RECORDER_AFTER_RESET_REQUIRED', {
      meetingId: liveMeetingIdRef.current,
      recorderState: audioRecorder.state,
      dualStream: dualStreamActive,
    })
    realtimeStream.clearQueuedAudio?.()
    audioRecorder.abortRecording()
    setLivePartialWarning('Transcript có thể chưa đầy đủ')

    void audioRecorder.startRecording()
      .then(() => {
        if (dualStreamActive && audioRecorder.getActiveStreamIds) {
          realtimeStream.configureDualStreams?.(audioRecorder.getActiveStreamIds())
        }
      })
      .catch((error) => {
        setLiveError(error instanceof Error ? error.message : 'Không thể khởi động lại ghi âm')
      })
  }, [
    audioRecorder,
    dualStreamActive,
    liveLifecycleState,
    liveMeetingIdRef,
    realtimeStream,
    resetRecoveryInProgressRef,
    setLiveError,
    setLivePartialWarning,
  ])

  useEffect(() => {
    const noTranscriptStatus =
      realtimeStream.status.state === 'NO_TRANSCRIPT_AFTER_FINALIZE'
      || realtimeStream.status.errorCode === 'NO_TRANSCRIPT_AFTER_FINALIZE'
      || realtimeStream.status.errorCode === 'NO_TRANSCRIPT'
      || realtimeStream.status.status === 'NO_TRANSCRIPT'
    if (!noTranscriptStatus) {
      return
    }

    const meetingId = liveMeetingIdRef.current
    if (meetingId === null) {
      return
    }

    liveAnalysisAbortControllerRef.current?.abort()
    liveAnalysisAbortControllerRef.current = null
    analysisPollRunIdRef.current += 1
    setLiveLifecycleState('no_transcript_after_finalize')
    setLiveAnalysis(null)
    setLiveAnalysisMetadata(buildLiveAnalysisMetadata(meetingId, 'NO_ANALYSIS', {
      errorCode: 'NO_TRANSCRIPT_AFTER_FINALIZE',
      transcriptRows: 0,
      finalized: true,
    }))
    setLiveAnalysisStatus('pending')
    setLiveAnalysisError(null)
    setLivePartialWarning('Chưa có transcript. Có thể do im lặng, mic tắt hoặc âm lượng quá thấp.')
    setLiveStatusMessage('Đã dừng ghi âm (chưa có transcript)')
  }, [
    analysisPollRunIdRef,
    liveAnalysisAbortControllerRef,
    liveMeetingIdRef,
    realtimeStream.status.errorCode,
    realtimeStream.status.state,
    realtimeStream.status.status,
    setLiveAnalysis,
    setLiveAnalysisError,
    setLiveAnalysisMetadata,
    setLiveAnalysisStatus,
    setLiveLifecycleState,
    setLivePartialWarning,
    setLiveStatusMessage,
  ])

  useEffect(() => {
    const statusState = realtimeStream.status.state
    const statusErrorCode = realtimeStream.status.errorCode
    const statusStatus = realtimeStream.status.status
    const failedAudioCapture =
      statusState === 'FAILED_AUDIO_CAPTURE'
      || statusErrorCode === 'FAILED_AUDIO_CAPTURE'
      || statusErrorCode === 'REALTIME_UNSUPPORTED_RECORDER_FORMAT'
      || statusStatus === 'FAILED_AUDIO_CAPTURE'
    if (!failedAudioCapture) {
      return
    }

    runTerminalAudioCaptureCleanupRef.current({
      expectedToken: activeRealtimeSessionTokenRef.current,
      errorMessage: 'Không thu được audio realtime hợp lệ. Kiểm tra định dạng ghi âm hoặc thử ghi lại.',
      statusMessage: 'Lỗi thu âm',
      partialWarning: 'Không thu được audio hợp lệ. Kiểm tra quyền mic và thử ghi lại.',
    })
  }, [
    activeRealtimeSessionTokenRef,
    realtimeStream.status.errorCode,
    realtimeStream.status.state,
    realtimeStream.status.status,
    runTerminalAudioCaptureCleanupRef,
  ])

  useEffect(() => {
    if (
      isFailedAudioCaptureLifecycle(liveLifecycleState)
      || realtimeStream.status.state === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.status === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.errorCode === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.errorCode === 'REALTIME_UNSUPPORTED_RECORDER_FORMAT'
    ) {
      return
    }

    const isRealtimeRecordingActive = audioRecorder.state === 'recording' || audioRecorder.state === 'paused'
    if (!isRealtimeRecordingActive) {
      return
    }

    if (realtimeStream.status.state !== 'reconnecting') {
      return
    }

    restartAfterReconnectRef.current = true
    realtimeStream.clearQueuedAudio?.()
    audioRecorder.abortRecording()
    setLiveStatusMessage('WebSocket bị ngắt, đang khôi phục kết nối...')
  }, [
    audioRecorder.state,
    liveLifecycleState,
    realtimeStream.clearQueuedAudio,
    realtimeStream.status.errorCode,
    realtimeStream.status.state,
    realtimeStream.status.status,
    restartAfterReconnectRef,
    setLiveStatusMessage,
    // abortRecording via ref-stable identity is not required; call through latest recorder ref
    audioRecorder.abortRecording,
  ])

  useEffect(() => {
    if (!restartAfterReconnectRef.current) {
      return
    }

    if (!realtimeStream.isAuthenticated) {
      return
    }

    if (audioRecorder.state !== 'idle' || liveMeetingIdRef.current === null) {
      return
    }

    if (isBrowserTabRecordingSource(selectedRecordingSourceRef.current)) {
      restartAfterReconnectRef.current = false
      setLiveError('Mất kết nối realtime trong khi ghi âm tab. Hãy dừng và bắt đầu lại để chọn lại tab trình duyệt.')
      setLiveLifecycleState('error')
      return
    }

    restartAfterReconnectRef.current = false
    setLiveStatusMessage('Đang ghi âm...')
    setLiveError(null)
    setLiveLifecycleState('recording')
    void audioRecorder.startRecording().catch((error) => {
      setLiveError(error instanceof Error ? error.message : 'Không thể khôi phục ghi âm sau khi reconnect')
    })
  }, [
    audioRecorder,
    liveMeetingIdRef,
    realtimeStream.isAuthenticated,
    restartAfterReconnectRef,
    selectedRecordingSourceRef,
    setLiveError,
    setLiveLifecycleState,
    setLiveStatusMessage,
  ])

  useEffect(() => {
    if (!realtimeStream.isAuthenticated) {
      return
    }

    if (liveLifecycleState === 'connecting') {
      setLiveStatusMessage(LIVE_STATUS_LISTENING)
      setLiveLifecycleState('recording')
    }
  }, [liveLifecycleState, realtimeStream.isAuthenticated, setLiveLifecycleState, setLiveStatusMessage])

  useEffect(() => {
    if (
      isRealtimeTerminalLifecycle(liveLifecycleState)
      || realtimeStream.status.state === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.status === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.errorCode === 'FAILED_AUDIO_CAPTURE'
      || realtimeStream.status.errorCode === 'REALTIME_UNSUPPORTED_RECORDER_FORMAT'
    ) {
      return
    }

    if (audioRecorder.state === 'connecting') {
      setLiveLifecycleState('connecting')
      return
    }

    if (audioRecorder.state === 'recording') {
      if (
        liveLifecycleState === 'stopping'
        || liveLifecycleState === 'finalizing_transcript'
        || isNoTranscriptTerminalLifecycle(liveLifecycleState)
        || isFailedAudioCaptureLifecycle(liveLifecycleState)
      ) {
        return
      }
      if (liveLifecycleState === 'connecting' && !realtimeStream.isAuthenticated) {
        return
      }
      setLiveLifecycleState('recording')
      return
    }

    if (audioRecorder.state === 'stopped') {
      if (
        liveLifecycleState === 'stopping'
        || liveLifecycleState === 'finalizing_transcript'
        || liveLifecycleState === 'transcript_ready'
        || liveLifecycleState === 'analysis_pending'
        || liveLifecycleState === 'analyzing'
        || liveLifecycleState === 'analysis_completed'
        || liveLifecycleState === 'analysis_failed'
        || isNoTranscriptTerminalLifecycle(liveLifecycleState)
        || isFailedAudioCaptureLifecycle(liveLifecycleState)
      ) {
        return
      }
      setLiveLifecycleState('stopped')
      return
    }

    if (audioRecorder.state === 'error') {
      setLiveLifecycleState('error')
    }
  }, [
    audioRecorder.state,
    liveLifecycleState,
    realtimeStream.isAuthenticated,
    realtimeStream.status.errorCode,
    realtimeStream.status.state,
    realtimeStream.status.status,
    setLiveLifecycleState,
  ])

  useEffect(() => {
    const voiceActivityUpdate = resolveVoiceActivityLifecycleUpdate({
      recorderState: audioRecorder.state,
      liveLifecycleState,
      previousVoiceActivityState: lastVoiceActivityStateRef.current,
      voiceActivityState: voiceActivity.state,
    })

    lastVoiceActivityStateRef.current = voiceActivityUpdate.nextTrackedVoiceActivityState

    if (voiceActivityUpdate.nextLifecycleState !== null) {
      setLiveLifecycleState(voiceActivityUpdate.nextLifecycleState)
    }

    if (voiceActivityUpdate.nextStatusMessage !== null) {
      setLiveStatusMessage(voiceActivityUpdate.nextStatusMessage)
    }
  }, [
    audioRecorder.state,
    lastVoiceActivityStateRef,
    liveLifecycleState,
    setLiveLifecycleState,
    setLiveStatusMessage,
    voiceActivity.state,
  ])
}
