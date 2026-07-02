export const RECORDING_SOURCES = ['microphone', 'browser_tab', 'browser_tab_with_mic'] as const

export type RecordingSource = (typeof RECORDING_SOURCES)[number]

export const DEFAULT_RECORDING_SOURCE: RecordingSource = 'microphone'

export const RECORDING_SOURCE_LABELS: Record<RecordingSource, string> = {
  microphone: 'Microphone',
  browser_tab: 'Ghi âm tab trình duyệt',
  browser_tab_with_mic: 'Tab trình duyệt + Microphone',
}

export const RECORDING_SOURCE_DESCRIPTIONS: Record<RecordingSource, string> = {
  microphone: 'Ghi âm giọng nói từ micro của bạn.',
  browser_tab: 'Chọn bất kỳ tab nào (Meet, Teams, YouTube, …) để ghi âm thanh phát từ tab.',
  browser_tab_with_mic: 'Ghi cả âm thanh tab trình duyệt và giọng nói của bạn. Tiêu thụ quota STT cao hơn (~2×) khi bật ghi kép.',
}

export const RECORDING_SOURCE_ICONS: Record<RecordingSource, string> = {
  microphone: '🎤',
  browser_tab: '🖥️',
  browser_tab_with_mic: '🎧',
}

export const TAB_CAPTURE_GUIDE_STEPS = [
  'Mở tab cần ghi ở cửa sổ khác (Meet, Teams, Zoom web, YouTube, … — Chrome/Edge desktop được khuyến nghị).',
  'Quay lại Audiomind, chọn “Ghi âm tab trình duyệt” hoặc “Tab trình duyệt + Microphone”.',
  'Khi trình duyệt hỏi, chọn đúng tab đang phát âm thanh.',
  'Bật “Chia sẻ âm thanh tab” nếu trình duyệt hiển thị tùy chọn này.',
  'Bạn có thể tắt loa/mute mic hệ thống — âm thanh vẫn được lấy trực tiếp từ tab.',
  'Bấm Ghi âm — transcript sẽ xuất hiện live qua Deepgram.',
] as const

/** Google Calendar / Meet integration scene — Meet-specific copy. */
export const MEET_CAPTURE_GUIDE_STEPS = [
  'Mở Google Meet ở tab khác (Chrome hoặc Edge desktop được khuyến nghị).',
  'Quay lại Audiomind, chọn “Ghi âm tab trình duyệt” hoặc “Tab trình duyệt + Microphone”.',
  'Khi trình duyệt hỏi, hãy chọn đúng tab Google Meet đang phát âm thanh.',
  'Bật “Chia sẻ âm thanh tab” nếu trình duyệt hiển thị tùy chọn này.',
  'Bấm Ghi âm — transcript tiếng Việt sẽ xuất hiện live qua Deepgram.',
] as const

export const TAB_BROWSER_COMPAT_NOTES = [
  'Chrome / Edge desktop: hỗ trợ tốt nhất cho tab audio capture.',
  'Firefox / Safari: có thể ghi được nhưng tab audio không ổn định — ưu tiên upload file nếu thất bại.',
  'Mobile: tab capture hạn chế — nên dùng máy tính.',
] as const

export const MEET_BROWSER_COMPAT_NOTES = TAB_BROWSER_COMPAT_NOTES

export const TAB_WITH_MIC_HEADPHONE_NOTE =
  'Nên dùng tai nghe để tránh vọng âm.'

export const TAB_WITH_MIC_QUOTA_NOTE =
  'Chế độ Tab + Microphone gửi hai luồng nhận dạng giọng nói song song (tab và mic). Mỗi giây ghi âm có thể tiêu tốn khoảng gấp đôi quota STT so với chỉ dùng microphone hoặc chỉ tab.'

export const TAB_WITH_MIC_QUOTA_RECORDING_BADGE =
  'Đang ghi 2 luồng STT — quota tiêu thụ nhanh hơn'

export const TAB_WITH_MIC_MIC_UNAVAILABLE_NOTE =
  'Microphone không khả dụng — chỉ ghi âm tab (quota ~1×).'

export const MEET_WITH_MIC_HEADPHONE_NOTE = TAB_WITH_MIC_HEADPHONE_NOTE

export const REALTIME_FOCUS_MEET_CAPTURE_KEY = 'audiomind.realtime.focus_meet_capture'
export const REALTIME_MEET_CAPTURE_TITLE_KEY = 'audiomind.realtime.meet_capture_title'

export type RealtimeMeetCaptureContext = {
  title?: string
}

export const RECORDING_SOURCE_ERRORS = {
  tabPickerCancelled: 'Bạn đã hủy chọn tab trình duyệt.',
  tabNoAudioTrack:
    'Tab được chọn không có âm thanh. Hãy chọn tab đang phát tiếng và bật chia sẻ âm thanh tab.',
  tabStopSharing:
    'Bạn đã dừng chia sẻ tab. Audiomind sẽ kết thúc ghi âm an toàn.',
  tabCaptureStalled:
    'Âm thanh tab ngừng đi vào pipeline ghi âm. Hãy kiểm tra tab đang phát tiếng hoặc chọn lại tab.',
  tabTinyOrSilentAudio:
    'Không phát hiện âm thanh từ tab. Hãy kiểm tra tab đang phát tiếng và bật chia sẻ âm thanh tab.',
  tabPermissionDenied:
    'Quyền chia sẻ tab bị từ chối. Hãy chọn tab đang phát âm thanh và bật chia sẻ âm thanh tab.',
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
