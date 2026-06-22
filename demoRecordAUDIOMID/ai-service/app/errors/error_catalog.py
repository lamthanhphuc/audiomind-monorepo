from __future__ import annotations

from typing import TypedDict


class ErrorCatalogEntry(TypedDict):
    message: str
    cta_id: str
    cta_label: str


ERROR_CATALOG: dict[str, ErrorCatalogEntry] = {
    "UPLOAD_EMPTY_FILE": {
        "message": "File trống. Vui lòng chọn file âm thanh hợp lệ.",
        "cta_id": "select_supported_file",
        "cta_label": "Chọn file khác",
    },
    "UPLOAD_TOO_LARGE": {
        "message": "File vượt quá dung lượng cho phép (tối đa 100MB).",
        "cta_id": "reduce_file_size",
        "cta_label": "Giảm dung lượng file",
    },
    "UPLOAD_UNSUPPORTED_FORMAT": {
        "message": "Định dạng file không được hỗ trợ. Vui lòng dùng .mp3, .wav hoặc .m4a.",
        "cta_id": "select_supported_file",
        "cta_label": "Chọn file khác",
    },
    "UPLOAD_INVALID_FILENAME": {
        "message": "Tên file không hợp lệ.",
        "cta_id": "select_supported_file",
        "cta_label": "Chọn file khác",
    },
    "UPLOAD_MIME_MISMATCH": {
        "message": "Nội dung file không khớp định dạng đã chọn.",
        "cta_id": "select_supported_file",
        "cta_label": "Chọn file khác",
    },
    "UPLOAD_SECURITY_SCAN_FAILED": {
        "message": "File không vượt qua kiểm tra bảo mật.",
        "cta_id": "select_supported_file",
        "cta_label": "Chọn file khác",
    },
    "REALTIME_CHUNK_TOO_LARGE": {
        "message": (
            "Đoạn âm thanh quá lớn. Vui lòng thử ghi lại; "
            "nếu lỗi lặp lại, liên hệ hỗ trợ."
        ),
        "cta_id": "retry_recording",
        "cta_label": "Thử ghi lại",
    },
    "REALTIME_UNSUPPORTED_ENCODING": {
        "message": "Định dạng ghi âm không được hỗ trợ.",
        "cta_id": "retry_recording",
        "cta_label": "Ghi lại",
    },
    "REALTIME_INVALID_PAYLOAD": {
        "message": "Dữ liệu realtime không hợp lệ.",
        "cta_id": "retry_recording",
        "cta_label": "Thử ghi lại",
    },
    "UNAUTHORIZED": {
        "message": "Phiên đăng nhập đã hết hạn.",
        "cta_id": "relogin",
        "cta_label": "Đăng nhập lại",
    },
    "FORBIDDEN": {
        "message": "Bạn không có quyền thực hiện thao tác này.",
        "cta_id": "contact_support",
        "cta_label": "Liên hệ hỗ trợ",
    },
}


def get_catalog_entry(error_code: str) -> ErrorCatalogEntry | None:
    normalized = str(error_code or "").strip().upper()
    if not normalized:
        return None
    return ERROR_CATALOG.get(normalized)


def resolve_cta(error_code: str) -> dict[str, str] | None:
    entry = get_catalog_entry(error_code)
    if entry is None:
        return None
    return {"id": entry["cta_id"], "label": entry["cta_label"]}
