package com.example.meetingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.when;

import com.example.meetingservice.config.Epic2FeatureFlags;
import com.example.meetingservice.config.UploadValidationPolicy;
import com.example.meetingservice.controller.ErrorCode;
import com.example.meetingservice.controller.UploadValidationException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;

class UploadValidatorTest {

    private final UploadValidationPolicy policy = new UploadValidationPolicy(new ObjectMapper());
    private final Epic2FeatureFlags flags = Mockito.mock(Epic2FeatureFlags.class);

    @Test
    void strictMode_rejectsUnsupportedExtension() {
        when(flags.isUploadValidationStrict()).thenReturn(true);
        UploadValidator validator = new UploadValidator(policy, flags);
        MockMultipartFile file = new MockMultipartFile("file", "demo.ogg", "audio/ogg", new byte[] {1, 2, 3});

        UploadValidationException ex = assertThrows(
                UploadValidationException.class,
                () -> validator.validate(file, file.getOriginalFilename())
        );

        assertEquals(ErrorCode.UPLOAD_UNSUPPORTED_FORMAT, ex.errorCode());
        assertEquals(HttpStatus.UNSUPPORTED_MEDIA_TYPE, ex.status());
    }

    @Test
    void strictMode_rejectsOversizedFile() {
        when(flags.isUploadValidationStrict()).thenReturn(true);
        UploadValidator validator = new UploadValidator(policy, flags);
        byte[] payload = new byte[(int) policy.maxUploadBytes() + 1];
        MockMultipartFile file = new MockMultipartFile("file", "demo.mp3", "audio/mpeg", payload);

        UploadValidationException ex = assertThrows(
                UploadValidationException.class,
                () -> validator.validate(file, file.getOriginalFilename())
        );

        assertEquals(ErrorCode.UPLOAD_TOO_LARGE, ex.errorCode());
        assertEquals(HttpStatus.PAYLOAD_TOO_LARGE, ex.status());
    }
}
