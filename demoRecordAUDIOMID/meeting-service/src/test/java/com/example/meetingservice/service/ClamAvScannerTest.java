package com.example.meetingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ClamAvScannerTest {

    @TempDir
    Path tempDir;

    @Test
    void scan_returnsPassedForCleanResponse() throws Exception {
        ScanCircuitBreaker breaker = new ScanCircuitBreaker();
        Path sample = tempDir.resolve("clean.mp3");
        Files.write(sample, new byte[] {1, 2, 3});
        ClamAvScanner scanner = new ClamAvScanner("/tmp/clamd.ctl", breaker) {
            @Override
            String sendInstream(byte[] payload) {
                return "stream: OK";
            }
        };

        ScanResult result = scanner.scan(sample, "trace-1");
        assertEquals(ScanResult.PASSED, result);
        assertFalse(breaker.isOpen());
    }

    @Test
    void scan_returnsFailedForFoundResponse() throws Exception {
        ScanCircuitBreaker breaker = new ScanCircuitBreaker();
        Path sample = tempDir.resolve("infected.mp3");
        Files.write(sample, new byte[] {4, 5, 6});
        ClamAvScanner scanner = new ClamAvScanner("/tmp/clamd.ctl", breaker) {
            @Override
            String sendInstream(byte[] payload) {
                return "stream: Eicar-Test-Signature FOUND";
            }
        };

        ScanResult result = scanner.scan(sample, "trace-2");
        assertEquals(ScanResult.FAILED, result);
    }

    @Test
    void scan_recordsInfraErrorWhenSocketFails() throws Exception {
        ScanCircuitBreaker breaker = new ScanCircuitBreaker();
        Path sample = tempDir.resolve("broken.mp3");
        Files.write(sample, new byte[] {7, 8, 9});
        ClamAvScanner scanner = new ClamAvScanner("/nonexistent/clamd.ctl", breaker);

        ScanResult result = scanner.scan(sample, "trace-3");
        assertEquals(ScanResult.INFRA_ERROR, result);
        assertEquals(1, breaker.failureCount());
    }
}
