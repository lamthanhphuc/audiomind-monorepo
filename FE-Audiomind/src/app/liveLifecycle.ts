import type { AudioRecorderState } from '../hooks/useAudioRecorder'
import type { VoiceActivityState } from '../hooks/useVoiceActivityDetection'

export type LiveLifecycleState =
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

export const LIVE_STATUS_LISTENING = 'Đang lắng nghe...'
export const LIVE_STATUS_PAUSED = 'Paused while silent — speak to continue'
export const LIVE_STATUS_RESUMED = 'Resumed — continuing to listen...'

export const isNoTranscriptTerminalLifecycle = (state: LiveLifecycleState): boolean => {
  return state === 'no_transcript_after_finalize' || state === 'stopped_no_analysis'
}

export const isFailedAudioCaptureLifecycle = (state: LiveLifecycleState): boolean => {
  return state === 'failed_audio_capture'
}

export const isRealtimeTerminalLifecycle = (state: LiveLifecycleState): boolean => {
  return isNoTranscriptTerminalLifecycle(state) || isFailedAudioCaptureLifecycle(state) || state === 'error'
}

type ResolveVoiceActivityLifecycleInput = {
  recorderState: AudioRecorderState
  liveLifecycleState: LiveLifecycleState
  previousVoiceActivityState: VoiceActivityState | null
  voiceActivityState: VoiceActivityState
}

type ResolveVoiceActivityLifecycleResult = {
  nextTrackedVoiceActivityState: VoiceActivityState | null
  nextLifecycleState: LiveLifecycleState | null
  nextStatusMessage: string | null
}

export const resolveVoiceActivityLifecycleUpdate = ({
  recorderState,
  liveLifecycleState,
  previousVoiceActivityState,
  voiceActivityState,
}: ResolveVoiceActivityLifecycleInput): ResolveVoiceActivityLifecycleResult => {
  if (recorderState !== 'recording') {
    return {
      nextTrackedVoiceActivityState: null,
      nextLifecycleState: null,
      nextStatusMessage: null,
    }
  }

  if (
    liveLifecycleState === 'stopping'
    || liveLifecycleState === 'stopped'
    || liveLifecycleState === 'no_transcript_after_finalize'
    || liveLifecycleState === 'stopped_no_analysis'
    || liveLifecycleState === 'failed_audio_capture'
    || liveLifecycleState === 'error'
  ) {
    return {
      nextTrackedVoiceActivityState: previousVoiceActivityState,
      nextLifecycleState: null,
      nextStatusMessage: null,
    }
  }

  if (previousVoiceActivityState === voiceActivityState) {
    return {
      nextTrackedVoiceActivityState: previousVoiceActivityState,
      nextLifecycleState: null,
      nextStatusMessage: null,
    }
  }

  if (voiceActivityState === 'silent_paused') {
    return {
      nextTrackedVoiceActivityState: voiceActivityState,
      nextLifecycleState: 'silent_paused',
      nextStatusMessage: LIVE_STATUS_PAUSED,
    }
  }

  if (voiceActivityState === 'listening_resumed') {
    return {
      nextTrackedVoiceActivityState: voiceActivityState,
      nextLifecycleState: 'listening_resumed',
      nextStatusMessage: LIVE_STATUS_RESUMED,
    }
  }

  return {
    nextTrackedVoiceActivityState: voiceActivityState,
    nextLifecycleState:
      liveLifecycleState === 'silent_paused' || liveLifecycleState === 'listening_resumed'
        ? 'recording'
        : null,
    nextStatusMessage: LIVE_STATUS_LISTENING,
  }
}

export const isRealtimeLanguageSelectorDisabled = (lifecycleState: LiveLifecycleState): boolean => {
  return (
    lifecycleState === 'connecting'
    || lifecycleState === 'recording'
    || lifecycleState === 'silent_paused'
    || lifecycleState === 'listening_resumed'
    || lifecycleState === 'stopping'
    || lifecycleState === 'finalizing_recording'
    || lifecycleState === 'finalizing_transcript'
  )
}

export const isRealtimeSpeakerModeSelectorDisabled = (lifecycleState: LiveLifecycleState): boolean => {
  return isRealtimeLanguageSelectorDisabled(lifecycleState)
}

export const isRecordingSourceSelectorDisabled = (lifecycleState: LiveLifecycleState): boolean => {
  return isRealtimeLanguageSelectorDisabled(lifecycleState)
}
