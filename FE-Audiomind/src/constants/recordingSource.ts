export const RECORDING_SOURCES = ['microphone', 'browser_tab', 'browser_tab_with_mic'] as const

export type RecordingSource = (typeof RECORDING_SOURCES)[number]

export const DEFAULT_RECORDING_SOURCE: RecordingSource = 'microphone'

export const RECORDING_SOURCE_LABELS: Record<RecordingSource, string> = {
  microphone: 'Microphone',
  browser_tab: 'Ghi âm Google Meet',
  browser_tab_with_mic: 'Google Meet + Microphone',
}

export const BROWSER_TAB_CAPTURE_TELEMETRY = {
  STARTED: 'BROWSER_TAB_AUDIO_CAPTURE_STARTED',
  TRACK_READY: 'BROWSER_TAB_AUDIO_TRACK_READY',
  MISSING: 'BROWSER_TAB_AUDIO_MISSING',
  TRACK_ENDED: 'BROWSER_TAB_AUDIO_TRACK_ENDED',
  CAPTURE_FAILED: 'BROWSER_TAB_AUDIO_CAPTURE_FAILED',
  REALTIME_STARTED: 'BROWSER_TAB_AUDIO_REALTIME_STARTED',
} as const

export const isBrowserTabRecordingSource = (source: RecordingSource): boolean =>
  source === 'browser_tab' || source === 'browser_tab_with_mic'

export const normalizeRecordingSource = (value: string | null | undefined): RecordingSource => {
  if (value === 'browser_tab' || value === 'browser_tab_with_mic' || value === 'microphone') {
    return value
  }
  return DEFAULT_RECORDING_SOURCE
}
