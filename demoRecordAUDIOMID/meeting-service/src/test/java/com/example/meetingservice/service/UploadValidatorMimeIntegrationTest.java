package com.example.meetingservice.service;

import com.example.meetingservice.config.Epic2FeatureFlags;
import com.example.meetingservice.config.UploadValidationPolicy;
import com.example.meetingservice.controller.ErrorCode;
import com.example.meetingservice.controller.UploadValidationException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.when;

class UploadValidatorMimeIntegrationTest {

    @Test
    void mimeSniffEnabled_rejectsExeRenamedMp3() {
        Epic2FeatureFlags flags = Mockito.mock(Epic2FeatureFlags.class);
        when(flags.isUploadValidationStrict()).thenReturn(true);
        when(flags.isMimeSniffEnabled()).thenReturn(true);

        UploadValidator validator = new UploadValidator(
                new UploadValidationPolicy(new ObjectMapper()),
                flags,
                new MimeSniffer(new UploadValidationPolicy(new ObjectMapper()), new MimeSniffRequestCache())
        );

        byte[] exeHeader = new byte[] {0x4D, 0x5A, (byte) 0x90, 0x00, 0x03, 0x00, 0x00, 0x00};
        MockMultipartFile file = new MockMultipartFile("file", "malware.mp3", "audio/mpeg", exeHeader);

        UploadValidationException ex = assertThrows(
                UploadValidationException.class,
                () -> validator.validate(file, file.getOriginalFilename())
        );

        assertEquals(ErrorCode.UPLOAD_MIME_MISMATCH, ex.errorCode());
        assertEquals(HttpStatus.UNSUPPORTED_MEDIA_TYPE, ex.status());
    }
}
