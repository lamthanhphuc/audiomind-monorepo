package com.example.processingservice.interfaces.websocket;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
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
    void validateMetadata_rejectsMp4MimeEvenWithWebmEncoding() {
        var result = validator.validateMetadata(1L, 100L, "audio/mp4", "webm-opus", null);
        assertFalse(result.valid());
        assertEquals(RealtimePayloadValidator.ValidationError.REALTIME_UNSUPPORTED_ENCODING, result.errorCode());
    }

    @Test
    void validateMetadata_rejectsWebmVorbisCodec() {
        var result = validator.validateMetadata(1L, 100L, "audio/webm;codecs=vorbis", "webm-opus", null);
        assertFalse(result.valid());
        assertEquals(RealtimePayloadValidator.ValidationError.REALTIME_UNSUPPORTED_AUDIO_CODEC, result.errorCode());
    }

    @Test
    void validateMetadata_rejectsMimeEncodingMismatchWhenMimeHasNonOpus() {
        var result = validator.validateMetadata(1L, 100L, "audio/webm; codecs=pcm", "webm-opus", null);
        assertFalse(result.valid());
        assertEquals(RealtimePayloadValidator.ValidationError.REALTIME_UNSUPPORTED_AUDIO_CODEC, result.errorCode());
    }

    @Test
    void validateMetadata_acceptsWebmOpusContract() {
        var result = validator.validateMetadata(1L, 100L, "audio/webm; codecs=opus", "webm-opus", null);
        assertTrue(result.valid());
    }

    @Test
    void validateMetadata_acceptsQuotedOpusCodec() {
        var result = validator.validateMetadata(1L, 100L, "audio/webm; codecs=\"opus\"", "webm-opus", null);
        assertTrue(result.valid());
    }

    @Test
    void validateMetadata_acceptsBareWebmWithWebmOpusEncoding() {
        var result = validator.validateMetadata(1L, 100L, "audio/webm", "webm-opus", null);
        assertTrue(result.valid());
    }

    @Test
    void sharedContractJsonMatchesValidatorConstants() throws Exception {
        Path contractPath = resolveContractPath();
        assertTrue(Files.isRegularFile(contractPath), "Missing contract at " + contractPath);

        JsonNode root = new ObjectMapper().readTree(Files.readString(contractPath));
        Set<String> containers = new HashSet<>();
        root.get("allowedContainers").forEach(n -> containers.add(n.asText()));
        Set<String> codecs = new HashSet<>();
        root.get("allowedCodecs").forEach(n -> codecs.add(n.asText()));

        assertEquals(RealtimePayloadValidator.ALLOWED_CONTAINERS, containers);
        assertEquals(RealtimePayloadValidator.ALLOWED_CODECS, codecs);
        assertEquals(RealtimePayloadValidator.ALLOW_BARE_WEBM, root.get("allowBareWebm").asBoolean(true));
        assertEquals("webm-opus", root.get("encoding").asText());
    }

    private static Path resolveContractPath() {
        Path cwd = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
        List<Path> candidates = List.of(
                cwd.resolve("../../packages/contracts/realtime-audio-format.json").normalize(),
                cwd.resolve("../packages/contracts/realtime-audio-format.json").normalize(),
                cwd.resolve("packages/contracts/realtime-audio-format.json").normalize(),
                cwd.getParent().resolve("packages/contracts/realtime-audio-format.json").normalize(),
                cwd.getParent().getParent().resolve("packages/contracts/realtime-audio-format.json").normalize()
        );
        for (Path candidate : candidates) {
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        return candidates.get(0);
    }
}
