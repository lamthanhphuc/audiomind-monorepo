export type ErrorCatalogEntry = {
  message: string
  ctaId: string
  ctaLabel: string
}

/** Maps Gate-A / legacy backend codes to catalog keys. */
export const ERROR_CODE_ALIASES: Record<string, string> = {
  EMPTY_FILE: 'UPLOAD_EMPTY_FILE',
  UNSUPPORTED_AUDIO_TYPE: 'UPLOAD_UNSUPPORTED_FORMAT',
  OWNER_FORBIDDEN: 'FORBIDDEN',
  MIC_PERMISSION_DENIED: 'MIC_PERMISSION_DENIED',
  CHECK_MIC: 'MIC_PERMISSION_DENIED',
  INVALID_AUDIO_CAPTURE: 'INVALID_AUDIO_CAPTURE',
  FAILED_AUDIO_CAPTURE: 'INVALID_AUDIO_CAPTURE',
  ANALYSIS_BUSY: 'ANALYSIS_BUSY',
  GEMINI_UNAVAILABLE: 'ANALYSIS_BUSY',
  CIRCUIT_OPEN: 'ANALYSIS_BUSY',
  EXPORT_ANALYSIS_REQUIRED: 'EXPORT_ANALYSIS_REQUIRED',
  GROUPED_ACTION_PLAN_UNAVAILABLE: 'GROUPED_ACTION_PLAN_UNAVAILABLE',
  GROUPED_ACTION_PLAN_INVALID: 'GROUPED_ACTION_PLAN_INVALID',
  GROUPED_ACTION_PLAN_EXPORT_FAILED: 'GROUPED_ACTION_PLAN_EXPORT_FAILED',
  QUERY_TOO_SHORT: 'QUERY_TOO_SHORT',
  RATE_LIMITED: 'RATE_LIMITED',
  NO_TRANSCRIPT_AFTER_FINALIZE: 'NO_TRANSCRIPT_AFTER_FINALIZE',
  NO_TRANSCRIPT: 'NO_TRANSCRIPT_AFTER_FINALIZE',
  QUOTA_BLOCKED: 'QUOTA_EXCEEDED',
}

export const ERROR_CATALOG: Record<string, ErrorCatalogEntry> = {
  UPLOAD_EMPTY_FILE: {
    message: 'File trống. Vui lòng chọn file âm thanh hợp lệ.',
    ctaId: 'select_supported_file',
    ctaLabel: 'Chọn file khác',
  },
  UPLOAD_TOO_LARGE: {
    message: 'File vượt quá dung lượng cho phép (tối đa 100MB).',
    ctaId: 'reduce_file_size',
    ctaLabel: 'Giảm dung lượng file',
  },
  UPLOAD_UNSUPPORTED_FORMAT: {
    message: 'Định dạng file không được hỗ trợ. Vui lòng dùng .mp3, .wav hoặc .m4a.',
    ctaId: 'select_supported_file',
    ctaLabel: 'Chọn file khác',
  },
  UPLOAD_INVALID_FILENAME: {
    message: 'Tên file không hợp lệ.',
    ctaId: 'select_supported_file',
    ctaLabel: 'Chọn file khác',
  },
  UPLOAD_MIME_MISMATCH: {
    message: 'Nội dung file không khớp định dạng đã chọn.',
    ctaId: 'select_supported_file',
    ctaLabel: 'Chọn file khác',
  },
  UPLOAD_SECURITY_SCAN_FAILED: {
    message: 'File không vượt qua kiểm tra bảo mật.',
    ctaId: 'select_supported_file',
    ctaLabel: 'Chọn file khác',
  },
  REALTIME_CHUNK_TOO_LARGE: {
    message: 'Đoạn âm thanh quá lớn. Vui lòng thử ghi lại; nếu lỗi lặp lại, liên hệ hỗ trợ.',
    ctaId: 'retry_recording',
    ctaLabel: 'Thử ghi lại',
  },
  REALTIME_UNSUPPORTED_ENCODING: {
    message: 'Định dạng ghi âm không được hỗ trợ.',
    ctaId: 'retry_recording',
    ctaLabel: 'Ghi lại',
  },
  REALTIME_UNSUPPORTED_AUDIO_CODEC: {
    message: 'Codec ghi âm realtime không được hỗ trợ. Hãy dùng trình duyệt hỗ trợ WebM/Opus (Chrome hoặc Edge).',
    ctaId: 'retry_recording',
    ctaLabel: 'Đổi trình duyệt hoặc ghi lại',
  },
  REALTIME_AUDIO_METADATA_MISMATCH: {
    message: 'Metadata âm thanh realtime không hợp lệ. Vui lòng thử ghi lại.',
    ctaId: 'retry_recording',
    ctaLabel: 'Thử ghi lại',
  },
  REALTIME_INVALID_PAYLOAD: {
    message: 'Dữ liệu realtime không hợp lệ.',
    ctaId: 'retry_recording',
    ctaLabel: 'Thử ghi lại',
  },
  MIC_PERMISSION_DENIED: {
    message: 'Microphone bị từ chối. Hãy cho phép quyền mic trong trình duyệt rồi thử lại.',
    ctaId: 'check_mic',
    ctaLabel: 'Kiểm tra microphone',
  },
  INVALID_AUDIO_CAPTURE: {
    message: 'Không ghi được âm thanh từ thiết bị. Kiểm tra mic hoặc thử nguồn ghi khác.',
    ctaId: 'check_mic',
    ctaLabel: 'Kiểm tra microphone',
  },
  NO_TRANSCRIPT_AFTER_FINALIZE: {
    message: 'Không phát hiện giọng nói trong phiên ghi âm.',
    ctaId: 'retry_recording',
    ctaLabel: 'Ghi lại',
  },
  ANALYSIS_BUSY: {
    message: 'AI đang bận, vui lòng thử lại sau.',
    ctaId: 'retry_later',
    ctaLabel: 'Thử lại sau',
  },
  EXPORT_ANALYSIS_REQUIRED: {
    message: 'Cần có phân tích cuộc họp trước khi xuất báo cáo hoặc action plan.',
    ctaId: 'run_analysis',
    ctaLabel: 'Chạy phân tích',
  },
  GROUPED_ACTION_PLAN_UNAVAILABLE: {
    message: 'Action plan nhóm chưa sẵn sàng cho cuộc họp này.',
    ctaId: 'view_analysis',
    ctaLabel: 'Xem phân tích',
  },
  GROUPED_ACTION_PLAN_INVALID: {
    message: 'Action plan nhóm không hợp lệ hoặc vượt giới hạn.',
    ctaId: 'contact_support',
    ctaLabel: 'Liên hệ hỗ trợ',
  },
  GROUPED_ACTION_PLAN_EXPORT_FAILED: {
    message: 'Không xuất được action plan nhóm. Vui lòng thử lại.',
    ctaId: 'retry_export',
    ctaLabel: 'Thử xuất lại',
  },
  QUERY_TOO_SHORT: {
    message: 'Từ khóa tìm kiếm quá ngắn. Nhập ít nhất 2 ký tự.',
    ctaId: 'refine_search',
    ctaLabel: 'Sửa từ khóa',
  },
  RATE_LIMITED: {
    message: 'Bạn thao tác quá nhanh. Vui lòng đợi vài giây rồi thử lại.',
    ctaId: 'retry_later',
    ctaLabel: 'Thử lại sau',
  },
  UNAUTHORIZED: {
    message: 'Phiên đăng nhập đã hết hạn.',
    ctaId: 'relogin',
    ctaLabel: 'Đăng nhập lại',
  },
  FORBIDDEN: {
    message: 'Bạn không có quyền thực hiện thao tác này.',
    ctaId: 'contact_support',
    ctaLabel: 'Liên hệ hỗ trợ',
  },
  QUOTA_EXCEEDED: {
    message: 'Bạn đã vượt quota sử dụng tháng này. Nâng cấp Pro để tiếp tục.',
    ctaId: 'upgrade_plan',
    ctaLabel: 'Xem gói & thanh toán',
  },
  GEMINI_QUOTA_EXHAUSTED: {
    message: 'AI đang quá tải (Gemini). Hệ thống sẽ tự thử lại.',
    ctaId: 'retry_later',
    ctaLabel: 'Thử lại sau',
  },
}

export type ErrorPresentation = {
  message: string
  ctaId?: string
  ctaLabel?: string
}

const resolveCatalogKey = (errorCode: string | undefined): string | undefined => {
  if (!errorCode) return undefined
  const normalized = errorCode.trim().toUpperCase()
  return ERROR_CODE_ALIASES[normalized] ?? normalized
}

/** Maps batch pipeline / polling error strings to catalog error codes. */
export const resolveBatchPipelineErrorCode = (
  errorMessage: string | null | undefined,
): string | undefined => {
  const normalized = (errorMessage || '').trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  const errorCodeMatch = normalized.match(/errorcode=([a-z0-9_]+)/i)
  if (errorCodeMatch?.[1]) {
    const aliased = resolveCatalogKey(errorCodeMatch[1].toUpperCase())
    if (aliased && ERROR_CATALOG[aliased]) {
      return aliased
    }
  }

  if (
    normalized.includes('geminiquotaexceedederror')
    || normalized.includes('gemini_quota_exhausted')
  ) {
    return 'GEMINI_QUOTA_EXHAUSTED'
  }

  if (
    normalized.includes('quota_exceeded')
    || normalized.includes('payment_required')
  ) {
    return 'QUOTA_EXCEEDED'
  }

  if (
    normalized.includes('analysisparseerror')
    || normalized.includes('invalid json')
  ) {
    return 'ANALYSIS_BUSY'
  }

  return undefined
}

export const resolveErrorPresentation = (
  errorCode: string | undefined,
  fallbackMessage: string,
  errorUxEnabled: boolean,
): ErrorPresentation => {
  if (!errorUxEnabled || !errorCode) {
    return { message: fallbackMessage }
  }

  const catalogKey = resolveCatalogKey(errorCode)
  const entry = catalogKey ? ERROR_CATALOG[catalogKey] : undefined
  if (!entry) {
    return { message: fallbackMessage }
  }

  return {
    message: entry.message,
    ctaId: entry.ctaId,
    ctaLabel: entry.ctaLabel,
  }
}
