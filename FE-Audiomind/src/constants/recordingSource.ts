export const RECORDING_SOURCES = ['microphone', 'browser_tab', 'browser_tab_with_mic'] as const

export type RecordingSource = (typeof RECORDING_SOURCES)[number]

export const DEFAULT_RECORDING_SOURCE: RecordingSource = 'microphone'

export const RECORDING_SOURCE_LABELS: Record<RecordingSource, string> = {
  microphone: 'Microphone',
  browser_tab: 'Ghi âm Google Meet',
  browser_tab_with_mic: 'Google Meet + Microphone',
}

export const RECORDING_SOURCE_DESCRIPTIONS: Record<RecordingSource, string> = {
  microphone: 'Ghi âm giọng nói từ micro của bạn.',
  browser_tab: 'Chọn tab Google Meet để ghi âm thanh cuộc họp.',
  browser_tab_with_mic: 'Ghi cả âm thanh Google Meet và giọng nói của bạn.',
}

export const RECORDING_SOURCE_ICONS: Record<RecordingSource, string> = {
  microphone: '🎤',
  browser_tab: '🖥️',
  browser_tab_with_mic: '🎧',
}

export const MEET_CAPTURE_GUIDE_STEPS = [
  'Mở Google Meet ở tab khác.',
  'Khi trình duyệt hỏi, hãy chọn tab Google Meet.',
  'Bật chia sẻ âm thanh tab nếu trình duyệt có tùy chọn.',
] as const

export const MEET_WITH_MIC_HEADPHONE_NOTE =
  'Nên dùng tai nghe để tránh vọng âm.'

export const RECORDING_SOURCE_ERRORS = {
  tabPickerCancelled: 'Bạn đã hủy chọn tab Google Meet.',
  tabNoAudioTrack:
    'Tab được chọn không có âm thanh. Hãy chọn tab Google Meet và bật chia sẻ âm thanh.',
  tabStopSharing:
    'Bạn đã dừng chia sẻ tab. Audiomind sẽ kết thúc ghi âm an toàn.',
  tabTinyOrSilentAudio:
    'Không phát hiện âm thanh từ tab Google Meet. Hãy kiểm tra tab đang phát tiếng và bật chia sẻ âm thanh.',
  tabPermissionDenied:
    'Quyền chia sẻ tab bị từ chối. Hãy chọn tab Google Meet và bật chia sẻ âm thanh tab.',
  micPermissionDenied:
    'Quyền microphone bị từ chối. Hãy cho phép truy cập microphone để ghi âm.',
  micTinyOrSilentAudio:
    'Không nhận được âm thanh từ microphone. Hãy kiểm tra quyền mic, thiết bị đầu vào và thử ghi lại.',
} as const

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

export const getRecordingSourceTinyChunkError = (source: RecordingSource): string =>
  isBrowserTabRecordingSource(source)
    ? RECORDING_SOURCE_ERRORS.tabTinyOrSilentAudio
    : RECORDING_SOURCE_ERRORS.micTinyOrSilentAudio
