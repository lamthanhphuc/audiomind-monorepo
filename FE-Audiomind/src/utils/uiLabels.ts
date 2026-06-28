const UPLOAD_STATUS_VI: Record<string, string> = {
  idle: 'Sẵn sàng',
  uploading: 'Đang tải lên…',
  processing: 'Đang xử lý…',
  'fetching-result': 'Đang lấy kết quả…',
  completed: 'Hoàn tất',
  failed: 'Thất bại',
  cancelled: 'Đã hủy',
}

const MEETING_STATUS_VI: Record<string, string> = {
  scheduled: 'Đã lên lịch',
  processing: 'Đang xử lý',
  completed: 'Hoàn tất',
  failed: 'Thất bại',
}

const INVOICE_STATUS_VI: Record<string, string> = {
  PAID: 'Đã thanh toán',
  PENDING: 'Chờ thanh toán',
  CANCELLED: 'Đã hủy',
  FAILED: 'Thất bại',
}

const REALTIME_LIFECYCLE_VI: Record<string, string> = {
  idle: 'Sẵn sàng',
  connecting: 'Đang kết nối…',
  recording: 'Đang ghi âm',
  silent_paused: 'Tạm dừng (im lặng)',
  listening_resumed: 'Đang lắng nghe',
  stopping: 'Đang dừng…',
  finalizing_recording: 'Đang hoàn tất ghi âm…',
  finalizing_transcript: 'Đang hoàn tất transcript…',
  transcript_ready: 'Transcript sẵn sàng',
  analysis_pending: 'Chờ phân tích',
  analyzing: 'Đang phân tích…',
  analysis_completed: 'Phân tích xong',
  analysis_failed: 'Phân tích thất bại',
  no_transcript_after_finalize: 'Không có transcript',
  failed_audio_capture: 'Không thu được âm thanh',
  stopped_no_analysis: 'Đã dừng (chưa phân tích)',
  stopped: 'Đã dừng',
  error: 'Lỗi',
}

export const formatUploadStatus = (status: string): string => {
  const key = status.trim().toLowerCase()
  return UPLOAD_STATUS_VI[key] ?? status
}

export const formatMeetingStatus = (status: string): string => {
  const key = status.trim().toLowerCase()
  return MEETING_STATUS_VI[key] ?? status
}

export const formatInvoiceStatus = (status: string): string => {
  const key = status.trim().toUpperCase()
  return INVOICE_STATUS_VI[key] ?? status
}

export const formatRealtimeLifecycle = (state: string): string => {
  const key = state.trim().toLowerCase()
  return REALTIME_LIFECYCLE_VI[key] ?? state
}

export const formatDateVi = (value: string | null | undefined): string => {
  if (!value?.trim()) return 'Chưa rõ ngày'
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(parsed))
}

const LANGUAGE_VI: Record<string, string> = {
  vi: 'Tiếng Việt',
  en: 'Tiếng Anh',
  multi: 'Việt + Anh',
}

export const formatLanguage = (code: string): string => {
  const key = code.trim().toLowerCase()
  return LANGUAGE_VI[key] ?? code
}

const ANALYSIS_STATUS_VI: Record<string, string> = {
  NO_ANALYSIS: 'Chưa phân tích',
  ANALYZING: 'Đang phân tích',
  COMPLETED: 'Hoàn tất',
  FAILED: 'Thất bại',
  STALE: 'Dữ liệu cũ',
  RATE_LIMITED: 'Giới hạn tốc độ',
  QUOTA_BLOCKED: 'Hết quota',
}

const DOMAIN_MODE_VI: Record<string, string> = {
  it: 'CNTT',
  business: 'Kinh doanh',
  education: 'Giáo dục',
  general: 'Tổng quát',
}

const VERIFICATION_STATUS_VI: Record<string, string> = {
  verified: 'Đã xác minh',
  unverified: 'Chưa xác minh',
  partial: 'Một phần',
}

export const formatAnalysisStatus = (status: string): string => {
  const key = status.trim().toUpperCase()
  return ANALYSIS_STATUS_VI[key] ?? status
}

export const formatDomainMode = (mode: string): string => {
  const key = mode.trim().toLowerCase()
  return DOMAIN_MODE_VI[key] ?? mode
}

export const formatBooleanVi = (value: boolean | undefined): string => {
  if (value === undefined) return 'Chưa rõ'
  return value ? 'Có' : 'Không'
}

export const formatVerificationStatus = (status: string | undefined): string => {
  if (!status?.trim()) return 'Chưa xác minh'
  const key = status.trim().toLowerCase()
  return VERIFICATION_STATUS_VI[key] ?? status
}

export const formatDateTimeVi = (value: string | undefined): string => {
  if (!value?.trim()) return 'Chưa rõ'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString('vi-VN')
}

export const formatActionPlanConfidence = (value: string | undefined): string => {
  const key = (value ?? 'NEEDS_REVIEW').trim().toUpperCase()
  if (key === 'SUPPORTED') return 'Có căn cứ'
  if (key === 'NEEDS_REVIEW') return 'Cần rà soát'
  return value ?? 'Cần rà soát'
}

const NOTIFICATION_TYPE_VI: Record<string, string> = {
  MEETING_SHARE_INVITE: 'Lời mời xem cuộc họp',
  JOB_COMPLETED: 'Xử lý hoàn tất',
  JOB_FAILED: 'Xử lý thất bại',
}

const JOB_STATUS_VI: Record<string, string> = {
  QUEUED: 'Đang chờ',
  RUNNING: 'Đang chạy',
  RETRYING: 'Thử lại',
  RECONNECTING: 'Kết nối lại',
  PARTIAL: 'Một phần',
  DEGRADED: 'Giảm chất lượng',
  PENDING: 'Chờ xử lý',
  COMPLETED: 'Hoàn tất',
  FAILED: 'Thất bại',
}

export const formatNotificationType = (type: string): string => {
  const key = type.trim().toUpperCase()
  return NOTIFICATION_TYPE_VI[key] ?? 'Thông báo'
}

export const formatJobStatus = (status: string): string => {
  const key = status.trim().toUpperCase()
  return JOB_STATUS_VI[key] ?? status
}

