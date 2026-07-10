import { useCallback, useRef, useState } from 'react'
import type { RealtimeLanguage, RealtimeSpeakerMode } from '../hooks/useRealtimeMeetingStream'
import type { MicSensitivityMode } from '../hooks/useVoiceActivityDetection'
import type { RecordingSource } from '../constants/recordingSource'
import {
  DEFAULT_RECORDING_SOURCE,
  isBrowserTabRecordingSource,
} from '../constants/recordingSource'
import {
  DEFAULT_REALTIME_LANGUAGE,
  DEFAULT_REALTIME_SPEAKER_MODE,
} from '../hooks/useRealtimeMeetingStream'
import {
  REALTIME_MIC_SENSITIVITY,
  REALTIME_NOISE_SUPPRESSION_DEFAULT,
} from '../services/config'
import { normalizeMicSensitivityMode } from '../hooks/useVoiceActivityDetection'

export const useRealtimeControls = () => {
  const [selectedRealtimeLanguage, setSelectedRealtimeLanguage] = useState<RealtimeLanguage>(DEFAULT_REALTIME_LANGUAGE)
  const [selectedRealtimeSpeakerMode, setSelectedRealtimeSpeakerMode] = useState<RealtimeSpeakerMode>(DEFAULT_REALTIME_SPEAKER_MODE)
  const [selectedMicSensitivity, setSelectedMicSensitivity] = useState<MicSensitivityMode>(
    normalizeMicSensitivityMode(REALTIME_MIC_SENSITIVITY),
  )
  const [selectedRecordingSource, setSelectedRecordingSource] = useState<RecordingSource>(DEFAULT_RECORDING_SOURCE)
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(REALTIME_NOISE_SUPPRESSION_DEFAULT)
  const selectedRecordingSourceRef = useRef<RecordingSource>(DEFAULT_RECORDING_SOURCE)

  const handleRecordingSourceChange = useCallback((source: RecordingSource) => {
    const previous = selectedRecordingSourceRef.current
    selectedRecordingSourceRef.current = source
    setSelectedRecordingSource(source)
    if (isBrowserTabRecordingSource(source) && !isBrowserTabRecordingSource(previous)) {
      setSelectedRealtimeSpeakerMode('multiple')
    }
  }, [])

  const selectMeetCaptureSource = useCallback((source: RecordingSource) => {
    selectedRecordingSourceRef.current = source
    setSelectedRecordingSource(source)
    setSelectedRealtimeSpeakerMode('multiple')
  }, [])

  return {
    selectedRealtimeLanguage,
    setSelectedRealtimeLanguage,
    selectedRealtimeSpeakerMode,
    setSelectedRealtimeSpeakerMode,
    selectedMicSensitivity,
    setSelectedMicSensitivity,
    selectedRecordingSource,
    setSelectedRecordingSource,
    selectedRecordingSourceRef,
    noiseSuppressionEnabled,
    setNoiseSuppressionEnabled,
    handleRecordingSourceChange,
    selectMeetCaptureSource,
  }
}
