from app.errors.error_catalog import ERROR_CATALOG, get_catalog_entry, resolve_cta


def test_p0_catalog_has_expected_upload_and_realtime_codes():
    expected = {
        "UPLOAD_EMPTY_FILE",
        "UPLOAD_TOO_LARGE",
        "UPLOAD_UNSUPPORTED_FORMAT",
        "UPLOAD_INVALID_FILENAME",
        "UPLOAD_MIME_MISMATCH",
        "UPLOAD_SECURITY_SCAN_FAILED",
        "REALTIME_CHUNK_TOO_LARGE",
        "REALTIME_UNSUPPORTED_ENCODING",
        "REALTIME_INVALID_PAYLOAD",
        "UNAUTHORIZED",
        "FORBIDDEN",
    }
    assert expected.issubset(ERROR_CATALOG.keys())


def test_p0_catalog_snapshot_messages_and_cta():
    assert get_catalog_entry("UPLOAD_TOO_LARGE") == {
        "message": "File vượt quá dung lượng cho phép (tối đa 100MB).",
        "cta_id": "reduce_file_size",
        "cta_label": "Giảm dung lượng file",
    }
    assert get_catalog_entry("UNAUTHORIZED") == {
        "message": "Phiên đăng nhập đã hết hạn.",
        "cta_id": "relogin",
        "cta_label": "Đăng nhập lại",
    }
    assert get_catalog_entry("REALTIME_CHUNK_TOO_LARGE") == {
        "message": (
            "Đoạn âm thanh quá lớn. Vui lòng thử ghi lại; "
            "nếu lỗi lặp lại, liên hệ hỗ trợ."
        ),
        "cta_id": "retry_recording",
        "cta_label": "Thử ghi lại",
    }


def test_resolve_cta_returns_none_for_unknown_code():
    assert resolve_cta("INTERNAL_ERROR") is None
