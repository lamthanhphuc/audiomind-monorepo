package com.example.meetingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.meetingservice.config.UploadValidationPolicy;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class MimeSnifferTest {

    private MimeSniffer mimeSniffer;

    @BeforeEach
    void setUp() {
        mimeSniffer = new MimeSniffer(
                new UploadValidationPolicy(new ObjectMapper()),
                new MimeSniffRequestCache()
        );
    }

    @Test
    void sniff_mp3Header_isNotConfidentMismatch() {
        byte[] sample = new byte[] {
                'I', 'D', '3', 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
        };

        MimeSniffer.MimeSniffResult result = mimeSniffer.sniff(sample, ".mp3", sample.length, "id3-prefix");

        assertTrue(result.classification() != MimeSniffer.MimeClassification.CONFIDENT_MISMATCH);
    }

    @Test
    void sniff_exeRenamedMp3_isConfidentMismatch() {
        byte[] sample = new byte[] {
                0x4D, 0x5A, (byte) 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00
        };

        MimeSniffer.MimeSniffResult result = mimeSniffer.sniff(sample, ".mp3", sample.length, "exe-prefix");

        assertEquals(MimeSniffer.MimeClassification.CONFIDENT_MISMATCH, result.classification());
    }

    @Test
    void sniff_usesRequestScopeCache() {
        byte[] sample = new byte[] {0x4D, 0x5A, 0x00, 0x01};

        MimeSniffer.MimeSniffResult first = mimeSniffer.sniff(sample, ".mp3", 10L, "cache-key");
        MimeSniffer.MimeSniffResult second = mimeSniffer.sniff(sample, ".mp3", 10L, "cache-key");

        assertEquals(MimeSniffer.MimeClassification.CONFIDENT_MISMATCH, first.classification());
        assertEquals(MimeSniffer.MimeClassification.CONFIDENT_MISMATCH, second.classification());
        assertTrue(second.fromCache());
    }

    @Test
    void sniff_perf_under50ms_for64kSample() {
        byte[] sample = new byte[64 * 1024];
        sample[0] = 'I';
        sample[1] = 'D';
        sample[2] = '3';

        long started = System.nanoTime();
        mimeSniffer.sniff(sample, ".mp3", sample.length, "perf-prefix");
        long elapsedMs = (System.nanoTime() - started) / 1_000_000L;

        assertTrue(elapsedMs < 200, "sniff latency was " + elapsedMs + "ms");
    }
}
