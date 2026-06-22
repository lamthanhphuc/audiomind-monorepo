package com.example.processingservice.interfaces.websocket;

import java.util.Locale;
import java.util.Set;
import org.springframework.stereotype.Component;

@Component
public class RealtimePayloadValidator {

    public static final long MAX_CHUNK_BYTES = 1_048_576L;
    private static final Set<String> ALLOWED_CONTAINERS = Set.of("webm");
    private static final Set<String> ALLOWED_CODECS = Set.of("opus", "webm-opus");

    public enum ValidationError {
        REALTIME_INVALID_PAYLOAD,
        REALTIME_CHUNK_TOO_LARGE,
        REALTIME_UNSUPPORTED_ENCODING
    }

    public record ValidationResult(boolean valid, ValidationError errorCode) {
        public static ValidationResult ok() {
            return new ValidationResult(true, null);
        }

        public static ValidationResult reject(ValidationError errorCode) {
            return new ValidationResult(false, errorCode);
        }
    }

    public ValidationResult validateMetadata(
            Long seq,
            Long declaredSize,
            String mimeType,
            String encoding,
            Long lastAcceptedSeq
    ) {
        if (seq == null || seq <= 0) {
            return ValidationResult.reject(ValidationError.REALTIME_INVALID_PAYLOAD);
        }
        if (lastAcceptedSeq != null && seq <= lastAcceptedSeq) {
            return ValidationResult.reject(ValidationError.REALTIME_INVALID_PAYLOAD);
        }
        long size = declaredSize == null ? 0L : declaredSize;
        if (size > MAX_CHUNK_BYTES) {
            return ValidationResult.reject(ValidationError.REALTIME_CHUNK_TOO_LARGE);
        }
        if (!isSupportedEncoding(mimeType, encoding)) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
        }
        return ValidationResult.ok();
    }

    public ValidationResult validateBinary(byte[] payload, Long declaredSize) {
        int payloadSize = payload == null ? 0 : payload.length;
        if (payloadSize > MAX_CHUNK_BYTES) {
            return ValidationResult.reject(ValidationError.REALTIME_CHUNK_TOO_LARGE);
        }
        long declared = declaredSize == null ? payloadSize : declaredSize;
        if (declared > MAX_CHUNK_BYTES) {
            return ValidationResult.reject(ValidationError.REALTIME_CHUNK_TOO_LARGE);
        }
        if (payloadSize > 0 && !looksLikeWebm(payload)) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
        }
        return ValidationResult.ok();
    }

    static boolean isSupportedEncoding(String mimeType, String encoding) {
        String normalizedMime = normalize(mimeType);
        String normalizedEncoding = normalize(encoding);

        if (normalizedEncoding.isBlank() && normalizedMime.isBlank()) {
            return false;
        }

        boolean codecOk = normalizedEncoding.isBlank()
                || ALLOWED_CODECS.stream().anyMatch(normalizedEncoding::contains)
                || normalizedEncoding.contains("opus");
        boolean containerOk = normalizedMime.isBlank()
                || ALLOWED_CONTAINERS.stream().anyMatch(normalizedMime::contains)
                || normalizedMime.contains("webm");
        return codecOk && containerOk;
    }

    static boolean looksLikeWebm(byte[] payload) {
        if (payload == null || payload.length < 4) {
            return false;
        }
        return payload[0] == 0x1A
                && payload[1] == 0x45
                && payload[2] == (byte) 0xDF
                && payload[3] == (byte) 0xA3;
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }
}
