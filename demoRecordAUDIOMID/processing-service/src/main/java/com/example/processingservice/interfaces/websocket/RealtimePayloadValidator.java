package com.example.processingservice.interfaces.websocket;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.springframework.stereotype.Component;

@Component
public class RealtimePayloadValidator {

    public static final long MAX_CHUNK_BYTES = 1_048_576L;
    /** Keep in sync with packages/contracts/realtime-audio-format.json */
    public static final Set<String> ALLOWED_CONTAINERS = Set.of("webm");
    /** Keep in sync with packages/contracts/realtime-audio-format.json */
    public static final Set<String> ALLOWED_CODECS = Set.of("opus", "webm-opus");
    /** Bare audio/webm (no codecs=) allowed; explicit non-opus codecs rejected. */
    public static final boolean ALLOW_BARE_WEBM = true;

    public enum ValidationError {
        REALTIME_INVALID_PAYLOAD,
        REALTIME_CHUNK_TOO_LARGE,
        REALTIME_UNSUPPORTED_ENCODING,
        REALTIME_UNSUPPORTED_AUDIO_CODEC,
        REALTIME_AUDIO_METADATA_MISMATCH
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
        return validateMimeAndEncoding(mimeType, encoding);
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
        // MediaRecorder timeslice chunks are often WebM cluster fragments without the EBML
        // magic prefix on every packet. Metadata validation already enforces webm/opus.
        return ValidationResult.ok();
    }

    static ValidationResult validateMimeAndEncoding(String mimeType, String encoding) {
        String normalizedEncoding = normalize(encoding);
        MimeParts mime = parseMimeType(mimeType);

        if (mime == null && normalizedEncoding.isBlank()) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
        }

        if (mime != null) {
            if (!"audio/webm".equals(mime.container())) {
                return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
            }
            if (!mime.codecs().isEmpty()) {
                boolean allOpus = mime.codecs().stream().allMatch(RealtimePayloadValidator::isOpusCodec);
                if (!allOpus) {
                    return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_AUDIO_CODEC);
                }
            } else if (!ALLOW_BARE_WEBM) {
                return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_AUDIO_CODEC);
            }
        } else if (!normalizedEncoding.isBlank() && !isAllowedEncoding(normalizedEncoding)) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
        }

        if (!normalizedEncoding.isBlank() && !isAllowedEncoding(normalizedEncoding)) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
        }

        // encoding=webm-opus with explicit non-opus mime codecs already rejected above.
        // Reject empty mime when encoding claims webm-opus without container confirmation? Allow
        // encoding-only when mime blank for backwards compatible callers that omit mime.
        if (mime != null && !normalizedEncoding.isBlank() && !isAllowedEncoding(normalizedEncoding)) {
            return ValidationResult.reject(ValidationError.REALTIME_AUDIO_METADATA_MISMATCH);
        }

        boolean containerOk = mime == null
                || ALLOWED_CONTAINERS.stream().anyMatch(c -> mime.container().contains(c));
        boolean encodingOk = normalizedEncoding.isBlank() || isAllowedEncoding(normalizedEncoding);
        if (!containerOk || !encodingOk) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
        }
        return ValidationResult.ok();
    }

    /** @deprecated Prefer validateMimeAndEncoding for typed errors. */
    @Deprecated
    static boolean isSupportedEncoding(String mimeType, String encoding) {
        return validateMimeAndEncoding(mimeType, encoding).valid();
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

    record MimeParts(String container, List<String> codecs) {}

    static MimeParts parseMimeType(String mimeType) {
        String raw = mimeType == null ? "" : mimeType.trim();
        if (raw.isEmpty()) {
            return null;
        }
        String[] parts = raw.split(";");
        String container = normalize(parts[0]);
        if (container.isEmpty()) {
            return null;
        }
        List<String> codecs = new ArrayList<>();
        for (int i = 1; i < parts.length; i++) {
            String part = parts[i].trim();
            String lower = part.toLowerCase(Locale.ROOT);
            if (!lower.startsWith("codecs")) {
                continue;
            }
            int eq = part.indexOf('=');
            if (eq < 0) {
                continue;
            }
            String value = part.substring(eq + 1).trim();
            if ((value.startsWith("\"") && value.endsWith("\""))
                    || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.substring(1, value.length() - 1);
            }
            for (String token : value.split(",")) {
                String codec = token.trim().toLowerCase(Locale.ROOT).replaceAll("^['\"]|['\"]$", "");
                if (!codec.isEmpty()) {
                    codecs.add(codec);
                }
            }
        }
        return new MimeParts(container, codecs);
    }

    private static boolean isOpusCodec(String codec) {
        String normalized = normalize(codec).replace(" ", "");
        return "opus".equals(normalized)
                || "webm-opus".equals(normalized)
                || "audio/opus".equals(normalized);
    }

    private static boolean isAllowedEncoding(String normalizedEncoding) {
        return ALLOWED_CODECS.stream().anyMatch(normalizedEncoding::contains)
                || normalizedEncoding.contains("opus");
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }
}
