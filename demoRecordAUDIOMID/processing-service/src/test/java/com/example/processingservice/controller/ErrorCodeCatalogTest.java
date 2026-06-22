package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import java.util.Map;
import org.junit.jupiter.api.Test;

class ErrorCodeCatalogTest {

    @Test
    void p0UploadTooLarge_hasVietnameseMessageAndCta() {
        ErrorCode code = ErrorCode.UPLOAD_TOO_LARGE;

        assertEquals(
                "File vượt quá dung lượng cho phép (tối đa 100MB).",
                code.displayMessage(true)
        );
        assertEquals("Upload file is too large", code.displayMessage(false));

        Map<String, Object> cta = code.ctaDetails(true);
        assertNotNull(cta);
        assertEquals("reduce_file_size", cta.get("id"));
        assertEquals("Giảm dung lượng file", cta.get("label"));
    }

    @Test
    void unauthorized_hasReloginCtaWhenUxEnabled() {
        ErrorCode code = ErrorCode.UNAUTHORIZED;

        assertEquals("Phiên đăng nhập đã hết hạn.", code.displayMessage(true));
        assertEquals("relogin", code.ctaDetails(true).get("id"));
    }
}
