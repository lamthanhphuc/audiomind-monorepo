package com.example.processingservice.controller;

import java.util.LinkedHashMap;
import java.util.Map;

public enum ErrorCode {
    ANALYSIS_NOT_READY(404, "Analysis is not ready yet"),
    TRANSCRIPT_NOT_READY(404, "Transcript is not ready yet"),
    RESOURCE_NOT_FOUND(404, "Resource not found"),
    UNAUTHORIZED(
            401,
            "Unauthorized",
            "Phiên đăng nhập đã hết hạn.",
            "relogin",
            "Đăng nhập lại"
    ),
    FORBIDDEN(
            403,
            "Forbidden",
            "Bạn không có quyền thực hiện thao tác này.",
            "contact_support",
            "Liên hệ hỗ trợ"
    ),
    CONFLICT(409, "Request conflicts with current resource state"),
    AI_SERVICE_UNAVAILABLE(503, "AI service is unavailable"),
    DATABASE_UNAVAILABLE(503, "Database dependency is unavailable"),
    SERVICE_UNAVAILABLE(503, "Service is unavailable"),
    DEEPGRAM_UNAVAILABLE(503, "Deepgram service is unavailable"),
    GEMINI_UNAVAILABLE(503, "Gemini service is unavailable"),
    GEMINI_ANALYSIS_FAILED(502, "Gemini analysis failed"),
    INVALID_LANGUAGE(400, "Invalid language"),
    EMPTY_TRANSCRIPT(422, "Transcript is empty"),
    DUPLICATE_REQUEST_SKIPPED(200, "Duplicate request skipped"),
    VALIDATION_ERROR(400, "Request validation failed"),
    UPLOAD_EMPTY_FILE(
            400,
            "Empty upload file",
            "File trống. Vui lòng chọn file âm thanh hợp lệ.",
            "select_supported_file",
            "Chọn file khác"
    ),
    UPLOAD_TOO_LARGE(
            413,
            "Upload file is too large",
            "File vượt quá dung lượng cho phép (tối đa 100MB).",
            "reduce_file_size",
            "Giảm dung lượng file"
    ),
    UPLOAD_UNSUPPORTED_FORMAT(
            415,
            "Unsupported upload format",
            "Định dạng file không được hỗ trợ. Vui lòng dùng .mp3, .wav hoặc .m4a.",
            "select_supported_file",
            "Chọn file khác"
    ),
    UPLOAD_INVALID_FILENAME(
            400,
            "Invalid upload filename",
            "Tên file không hợp lệ.",
            "select_supported_file",
            "Chọn file khác"
    ),
    UPLOAD_MIME_MISMATCH(
            415,
            "Upload MIME type mismatch",
            "Nội dung file không khớp định dạng đã chọn.",
            "select_supported_file",
            "Chọn file khác"
    ),
    UPLOAD_SECURITY_SCAN_FAILED(
            422,
            "Upload security scan failed",
            "File không vượt qua kiểm tra bảo mật.",
            "select_supported_file",
            "Chọn file khác"
    ),
    REALTIME_CHUNK_TOO_LARGE(
            413,
            "Realtime audio chunk is too large",
            "Đoạn âm thanh quá lớn. Vui lòng thử ghi lại; nếu lỗi lặp lại, liên hệ hỗ trợ.",
            "retry_recording",
            "Thử ghi lại"
    ),
    REALTIME_UNSUPPORTED_ENCODING(
            415,
            "Unsupported realtime encoding",
            "Định dạng ghi âm không được hỗ trợ.",
            "retry_recording",
            "Ghi lại"
    ),
    REALTIME_INVALID_PAYLOAD(
            400,
            "Invalid realtime payload",
            "Dữ liệu realtime không hợp lệ.",
            "retry_recording",
            "Thử ghi lại"
    ),
    QUOTA_EXCEEDED(
            402,
            "Usage quota exceeded",
            "Bạn đã vượt quota sử dụng. Vui lòng nâng cấp gói hoặc thanh toán để tiếp tục.",
            "upgrade_plan",
            "Nâng cấp gói"
    ),
    EXPORT_ANALYSIS_REQUIRED(
            409,
            "Analysis is required before export",
            "Cần có phân tích cuộc họp trước khi xuất báo cáo hoặc action plan.",
            "run_analysis",
            "Chạy phân tích"
    ),
    GROUPED_ACTION_PLAN_UNAVAILABLE(
            409,
            "Grouped action plan unavailable",
            "Action plan nhóm chưa sẵn sàng cho cuộc họp này.",
            "view_analysis",
            "Xem phân tích"
    ),
    GROUPED_ACTION_PLAN_INVALID(
            422,
            "Grouped action plan invalid",
            "Action plan nhóm không hợp lệ hoặc vượt giới hạn.",
            "contact_support",
            "Liên hệ hỗ trợ"
    ),
    GROUPED_ACTION_PLAN_EXPORT_FAILED(
            500,
            "Grouped action plan export failed",
            "Không xuất được action plan nhóm. Vui lòng thử lại.",
            "retry_export",
            "Thử xuất lại"
    ),
    RATE_LIMITED(
            429,
            "Too many requests",
            "Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau.",
            "retry_later",
            "Thử lại sau"
    ),
    INTERNAL_ERROR(500, "Unexpected server error");

    private final int status;
    private final String defaultMessage;
    private final String vietnameseMessage;
    private final String ctaId;
    private final String ctaLabel;

    ErrorCode(int status, String defaultMessage) {
        this(status, defaultMessage, null, null, null);
    }

    ErrorCode(
            int status,
            String defaultMessage,
            String vietnameseMessage,
            String ctaId,
            String ctaLabel
    ) {
        this.status = status;
        this.defaultMessage = defaultMessage;
        this.vietnameseMessage = vietnameseMessage;
        this.ctaId = ctaId;
        this.ctaLabel = ctaLabel;
    }

    public int status() {
        return status;
    }

    public String defaultMessage() {
        return defaultMessage;
    }

    public String displayMessage(boolean errorUxEnabled) {
        if (errorUxEnabled && vietnameseMessage != null && !vietnameseMessage.isBlank()) {
            return vietnameseMessage;
        }
        return defaultMessage;
    }

    public Map<String, Object> ctaDetails(boolean errorUxEnabled) {
        if (!errorUxEnabled || ctaId == null || ctaId.isBlank()) {
            return null;
        }
        Map<String, Object> cta = new LinkedHashMap<>();
        cta.put("id", ctaId);
        cta.put("label", ctaLabel == null || ctaLabel.isBlank() ? ctaId : ctaLabel);
        return cta;
    }

    public Map<String, Object> mergeDetails(boolean errorUxEnabled, Map<String, Object> details) {
        Map<String, Object> cta = ctaDetails(errorUxEnabled);
        if (cta == null && (details == null || details.isEmpty())) {
            return details;
        }
        Map<String, Object> merged = details == null ? new LinkedHashMap<>() : new LinkedHashMap<>(details);
        if (cta != null) {
            merged.put("cta", cta);
        }
        return merged.isEmpty() ? null : merged;
    }
}
