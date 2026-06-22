package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.when;

import com.example.processingservice.config.Epic2FeatureFlags;
import com.example.processingservice.config.UploadValidationPolicy;
import com.example.processingservice.controller.ErrorCode;
import com.example.processingservice.controller.UploadValidationException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.mock.web.MockMultipartFile;

class UploadValidatorTest {

    private final UploadValidationPolicy policy = new UploadValidationPolicy(new ObjectMapper());
    private final Epic2FeatureFlags flags = Mockito.mock(Epic2FeatureFlags.class);

    @Test
    void nonStrictMode_skipsValidation() {
        when(flags.isUploadValidationStrict()).thenReturn(false);
        UploadValidator validator = new UploadValidator(policy, flags);
        MockMultipartFile file = new MockMultipartFile("file", "demo.ogg", "audio/ogg", new byte[] {1});

        assertDoesNotThrow(() -> validator.validateIfStrict(file, file.getOriginalFilename()));
    }

    @Test
    void strictMode_rejectsUnsupportedExtension() {
        when(flags.isUploadValidationStrict()).thenReturn(true);
        UploadValidator validator = new UploadValidator(policy, flags);
        MockMultipartFile file = new MockMultipartFile("file", "demo.ogg", "audio/ogg", new byte[] {1});

        UploadValidationException ex = assertThrows(
                UploadValidationException.class,
                () -> validator.validateIfStrict(file, file.getOriginalFilename())
        );
        assertEquals(ErrorCode.UPLOAD_UNSUPPORTED_FORMAT, ex.errorCode());
    }
}
