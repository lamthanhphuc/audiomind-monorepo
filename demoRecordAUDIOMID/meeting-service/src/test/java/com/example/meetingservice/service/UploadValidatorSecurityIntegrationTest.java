package com.example.meetingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

import com.example.meetingservice.config.Epic2FeatureFlags;
import com.example.meetingservice.config.UploadValidationPolicy;
import com.example.meetingservice.controller.ErrorCode;
import com.example.meetingservice.controller.UploadValidationException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;

class UploadValidatorSecurityIntegrationTest {

    private final UploadValidationPolicy policy = new UploadValidationPolicy(new ObjectMapper());
    private final Epic2FeatureFlags flags = Mockito.mock(Epic2FeatureFlags.class);
    private final MimeSniffer mimeSniffer = new MimeSniffer(policy, new MimeSniffRequestCache());
    private final UploadSecurityScanner scanner = Mockito.mock(UploadSecurityScanner.class);
    private final ScanCircuitBreaker circuitBreaker = new ScanCircuitBreaker();

    @BeforeEach
    void setUp() {
        when(flags.isMimeSniffEnabled()).thenReturn(false);
        when(flags.isUploadValidationStrict()).thenReturn(false);
        when(flags.isUploadSecurityScanEnabled()).thenReturn(true);
        when(flags.isUploadScanFailOpen()).thenReturn(false);
    }

    private UploadValidator validator() {
        return new UploadValidator(policy, flags, mimeSniffer, scanner, circuitBreaker);
    }

    @Test
    void infectedUpload_rejectedWithSecurityScanFailed() {
        when(scanner.scan(any(Path.class), eq("trace-infected"))).thenReturn(ScanResult.FAILED);
        MockMultipartFile file = new MockMultipartFile("file", "demo.mp3", "audio/mpeg", new byte[] {1, 2, 3});

        UploadValidationException ex = assertThrows(
                UploadValidationException.class,
                () -> validator().validate(file, file.getOriginalFilename(), "trace-infected")
        );

        assertEquals(ErrorCode.UPLOAD_SECURITY_SCAN_FAILED, ex.errorCode());
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, ex.status());
    }

    @Test
    void infraError_failOpen_allowsUpload() {
        when(flags.isUploadScanFailOpen()).thenReturn(true);
        when(scanner.scan(any(Path.class), eq("trace-open"))).thenReturn(ScanResult.INFRA_ERROR);
        MockMultipartFile file = new MockMultipartFile("file", "demo.mp3", "audio/mpeg", new byte[] {1, 2, 3});

        validator().validate(file, file.getOriginalFilename(), "trace-open");
    }

    @Test
    void circuitOpen_rejectsUploadBeforeScan() {
        for (int i = 0; i < ScanCircuitBreaker.FAILURE_THRESHOLD; i++) {
            circuitBreaker.recordFailure();
        }
        MockMultipartFile file = new MockMultipartFile("file", "demo.mp3", "audio/mpeg", new byte[] {1, 2, 3});

        UploadValidationException ex = assertThrows(
                UploadValidationException.class,
                () -> validator().validate(file, file.getOriginalFilename(), "trace-circuit")
        );

        assertEquals(ErrorCode.UPLOAD_SECURITY_SCAN_FAILED, ex.errorCode());
    }
}
