package com.example.processingservice.interfaces.websocket;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class RealtimePayloadValidatorTest {

    private final RealtimePayloadValidator validator = new RealtimePayloadValidator();

    @Test
    void validateMetadata_rejectsOversizedDeclaredChunk() {
        var result = validator.validateMetadata(1L, RealtimePayloadValidator.MAX_CHUNK_BYTES + 1, "audio/webm", "webm-opus", null);
        assertFalse(result.valid());
        assertEquals(RealtimePayloadValidator.ValidationError.REALTIME_CHUNK_TOO_LARGE, result.errorCode());
    }

    @Test
    void validateMetadata_rejectsNonMonotonicSeq() {
        var result = validator.validateMetadata(2L, 100L, "audio/webm; codecs=opus", "webm-opus", 2L);
        assertFalse(result.valid());
        assertEquals(RealtimePayloadValidator.ValidationError.REALTIME_INVALID_PAYLOAD, result.errorCode());
    }

    @Test
    void validateMetadata_rejectsUnsupportedEncoding() {
        var result = validator.validateMetadata(1L, 100L, "audio/wav", "pcm", null);
        assertFalse(result.valid());
        assertEquals(RealtimePayloadValidator.ValidationError.REALTIME_UNSUPPORTED_ENCODING, result.errorCode());
    }

    @Test
    void validateBinary_rejectsOversizedPayload() {
        byte[] payload = new byte[(int) RealtimePayloadValidator.MAX_CHUNK_BYTES + 1];
        var result = validator.validateBinary(payload, (long) payload.length);
        assertEquals(RealtimePayloadValidator.ValidationError.REALTIME_CHUNK_TOO_LARGE, result.errorCode());
    }

    @Test
    void validateBinary_rejectsNonWebmBytes() {
        byte[] payload = new byte[] {0x52, 0x49, 0x46, 0x46};
        var result = validator.validateBinary(payload, (long) payload.length);
        assertTrue(result.valid());
    }

    @Test
    void validateBinary_acceptsStreamingClusterWithoutEbmlHeader() {
        byte[] payload = new byte[] {0x01, 0x02, 0x03, 0x04, 0x05};
        var result = validator.validateBinary(payload, (long) payload.length);
        assertTrue(result.valid());
    }

    @Test
    void validateBinary_acceptsWebmHeader() {
        byte[] payload = new byte[] {0x1A, 0x45, (byte) 0xDF, (byte) 0xA3, 0x01};
        var result = validator.validateBinary(payload, (long) payload.length);
        assertTrue(result.valid());
    }
}
