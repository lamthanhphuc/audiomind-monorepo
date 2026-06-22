export type ErrorCatalogEntry = {
  message: string
  ctaId: string
  ctaLabel: string
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
  REALTIME_INVALID_PAYLOAD: {
    message: 'Dữ liệu realtime không hợp lệ.',
    ctaId: 'retry_recording',
    ctaLabel: 'Thử ghi lại',
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
}

export type ErrorPresentation = {
  message: string
  ctaId?: string
  ctaLabel?: string
}

export const resolveErrorPresentation = (
  errorCode: string | undefined,
  fallbackMessage: string,
  errorUxEnabled: boolean,
): ErrorPresentation => {
  if (!errorUxEnabled || !errorCode) {
    return { message: fallbackMessage }
  }

  const entry = ERROR_CATALOG[errorCode.trim().toUpperCase()]
  if (!entry) {
    return { message: fallbackMessage }
  }

  return {
    message: entry.message,
    ctaId: entry.ctaId,
    ctaLabel: entry.ctaLabel,
  }
}
