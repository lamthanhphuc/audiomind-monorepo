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
    /** MIME codec tokens (codecs=...). Keep in sync with contract allowedCodecs. */
    public static final Set<String> ALLOWED_CODECS = Set.of("opus", "webm-opus");
    /** Exact wire encodings. Keep in sync with contract wireEncodings / encoding. */
    public static final Set<String> ALLOWED_WIRE_ENCODINGS = Set.of("webm-opus");
    /** Bare audio/webm (no codecs parameter) allowed; empty/malformed codecs= rejected. */
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
        if (normalizedEncoding.isBlank()) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
        }
        if (!isAllowedWireEncoding(normalizedEncoding)) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
        }

        MimeParts mime = parseMimeType(mimeType);
        if (mime == null) {
            return ValidationResult.reject(ValidationError.REALTIME_AUDIO_METADATA_MISMATCH);
        }
        if (!"audio/webm".equals(mime.container())) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_ENCODING);
        }
        if (mime.codecParameterMalformed()) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_AUDIO_CODEC);
        }
        if (mime.codecParameterPresent()) {
            if (mime.codecs().isEmpty()) {
                return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_AUDIO_CODEC);
            }
            boolean allOpus = mime.codecs().stream().allMatch(RealtimePayloadValidator::isOpusCodec);
            if (!allOpus) {
                return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_AUDIO_CODEC);
            }
        } else if (!ALLOW_BARE_WEBM) {
            return ValidationResult.reject(ValidationError.REALTIME_UNSUPPORTED_AUDIO_CODEC);
        }

        boolean containerOk = ALLOWED_CONTAINERS.stream().anyMatch(c -> mime.container().contains(c));
        if (!containerOk) {
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

    record MimeParts(
            String container,
            List<String> codecs,
            boolean codecParameterPresent,
            boolean codecParameterMalformed
    ) {}

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
        boolean codecParameterPresent = false;
        boolean codecParameterMalformed = false;

        for (int i = 1; i < parts.length; i++) {
            String part = parts[i].trim();
            int eq = part.indexOf('=');
            if (eq < 0) {
                if ("codecs".equals(part.toLowerCase(Locale.ROOT))) {
                    codecParameterPresent = true;
                    codecParameterMalformed = true;
                }
                continue;
            }

            String name = part.substring(0, eq).trim().toLowerCase(Locale.ROOT);
            // Exact parameter name only — never startsWith("codecs").
            if (!"codecs".equals(name)) {
                continue;
            }

            codecParameterPresent = true;
            String rawValue = part.substring(eq + 1);
            if (rawValue.trim().isEmpty()) {
                codecParameterMalformed = true;
                continue;
            }

            UnquotedCodecValue unquoted = stripBalancedQuotes(rawValue);
            if (unquoted.malformed() || unquoted.value().trim().isEmpty()) {
                codecParameterMalformed = true;
                continue;
            }

            boolean sawToken = false;
            // Keep trailing empty tokens so "opus," / "opus,," are rejected.
            for (String token : unquoted.value().split(",", -1)) {
                String codec = token.trim().toLowerCase(Locale.ROOT).replaceAll("^['\"]|['\"]$", "");
                if (codec.isEmpty()) {
                    codecParameterMalformed = true;
                    continue;
                }
                sawToken = true;
                codecs.add(codec);
            }
            if (!sawToken) {
                codecParameterMalformed = true;
            }
        }
        return new MimeParts(container, codecs, codecParameterPresent, codecParameterMalformed);
    }

    private record UnquotedCodecValue(String value, boolean malformed) {}

    private static UnquotedCodecValue stripBalancedQuotes(String value) {
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return new UnquotedCodecValue("", false);
        }
        boolean startsDouble = trimmed.startsWith("\"");
        boolean endsDouble = trimmed.endsWith("\"");
        boolean startsSingle = trimmed.startsWith("'");
        boolean endsSingle = trimmed.endsWith("'");
        if (startsDouble || endsDouble) {
            if (!(startsDouble && endsDouble) || trimmed.length() < 2) {
                return new UnquotedCodecValue(trimmed, true);
            }
            return new UnquotedCodecValue(trimmed.substring(1, trimmed.length() - 1), false);
        }
        if (startsSingle || endsSingle) {
            if (!(startsSingle && endsSingle) || trimmed.length() < 2) {
                return new UnquotedCodecValue(trimmed, true);
            }
            return new UnquotedCodecValue(trimmed.substring(1, trimmed.length() - 1), false);
        }
        return new UnquotedCodecValue(trimmed, false);
    }

    private static boolean isOpusCodec(String codec) {
        // Exact membership after trim + lowercase only — never strip internal whitespace.
        String normalized = normalize(codec);
        return ALLOWED_CODECS.contains(normalized);
    }

    private static boolean isAllowedWireEncoding(String normalizedEncoding) {
        return ALLOWED_WIRE_ENCODINGS.contains(normalizedEncoding);
    }

    private static String normalize(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }
}
