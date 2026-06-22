package com.example.meetingservice.service;

import com.example.meetingservice.config.UploadValidationPolicy;
import java.io.ByteArrayInputStream;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.apache.tika.Tika;
import org.apache.tika.config.TikaConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class MimeSniffer {

    private static final Logger log = LoggerFactory.getLogger(MimeSniffer.class);
    private static final int MAX_SNIFF_BYTES = 64 * 1024;
    private static final Set<String> AMBIGUOUS_MIME_TYPES = Set.of(
            "application/octet-stream",
            "application/binary",
            "binary/octet-stream"
    );
    private static final Map<String, Set<String>> EXTENSION_EXPECTED_MIMES = Map.of(
            ".mp3", Set.of("audio/mpeg", "audio/mp3", "audio/x-mpeg", "audio/mpeg3"),
            ".wav", Set.of("audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"),
            ".m4a", Set.of("audio/mp4", "audio/x-m4a", "audio/aac", "audio/x-aac", "video/mp4")
    );

    public enum MimeClassification {
        CONFIDENT_MISMATCH,
        AMBIGUOUS,
        UNKNOWN,
        MATCH
    }

    public record MimeSniffResult(
            MimeClassification classification,
            String detectedMime,
            boolean fromCache
    ) {
        static MimeSniffResult cached(MimeClassification classification, String detectedMime) {
            return new MimeSniffResult(classification, detectedMime, true);
        }

        static MimeSniffResult fresh(MimeClassification classification, String detectedMime) {
            return new MimeSniffResult(classification, detectedMime, false);
        }
    }

    private final UploadValidationPolicy policy;
    private final MimeSniffRequestCache requestCache;
    private final Tika tika;

    public MimeSniffer(UploadValidationPolicy policy, MimeSniffRequestCache requestCache) {
        this.policy = policy;
        this.requestCache = requestCache;
        this.tika = createTika();
    }

    public MimeSniffResult sniff(byte[] sample, String extension, long fileSize, String contentHashPrefix) {
        String cacheKey = contentHashPrefix + ":" + fileSize;
        MimeSniffResult cached = requestCache.get(cacheKey);
        if (cached != null) {
            return MimeSniffResult.cached(cached.classification(), cached.detectedMime());
        }

        if (sample == null || sample.length == 0) {
            MimeSniffResult result = MimeSniffResult.fresh(MimeClassification.UNKNOWN, "");
            requestCache.put(cacheKey, result);
            log.info("event=UPLOAD_VALIDATION_MIME_FALLBACK reason=empty_sample");
            return result;
        }

        if (tika == null) {
            MimeSniffResult result = MimeSniffResult.fresh(MimeClassification.UNKNOWN, "");
            requestCache.put(cacheKey, result);
            log.warn("event=UPLOAD_VALIDATION_MIME_FALLBACK reason=library_unavailable");
            return result;
        }

        byte[] sniffBytes = sample.length > MAX_SNIFF_BYTES
                ? java.util.Arrays.copyOf(sample, MAX_SNIFF_BYTES)
                : sample;
        String detectedMime = detectMime(sniffBytes, extension);
        MimeClassification classification = classify(detectedMime, extension);

        MimeSniffResult result = MimeSniffResult.fresh(classification, detectedMime);
        requestCache.put(cacheKey, result);

        if (classification == MimeClassification.CONFIDENT_MISMATCH) {
            log.warn(
                    "event=MIME_MISMATCH detectedMime={} extension={} fileSize={}",
                    detectedMime,
                    extension,
                    fileSize
            );
        } else if (classification == MimeClassification.AMBIGUOUS || classification == MimeClassification.UNKNOWN) {
            log.info(
                    "event=UPLOAD_VALIDATION_MIME_FALLBACK reason=ambiguous_detected detectedMime={} extension={}",
                    detectedMime,
                    extension
            );
        } else {
            log.info(
                    "event=UPLOAD_VALIDATION_MIME_CHECKED detectedMime={} extension={} fileSize={}",
                    detectedMime,
                    extension,
                    fileSize
            );
        }

        return result;
    }

    private String detectMime(byte[] sample, String extension) {
        try {
            String resourceName = "upload" + normalizeExtension(extension);
            return tika.detect(new ByteArrayInputStream(sample), resourceName);
        } catch (Exception ex) {
            log.warn("event=UPLOAD_VALIDATION_MIME_FALLBACK reason=library_unavailable errorCode={}", ex.getClass().getSimpleName());
            return "";
        }
    }

    private MimeClassification classify(String detectedMime, String extension) {
        String normalizedMime = normalizeMime(detectedMime);
        if (normalizedMime.isBlank()) {
            return MimeClassification.UNKNOWN;
        }
        if (AMBIGUOUS_MIME_TYPES.contains(normalizedMime)) {
            return MimeClassification.AMBIGUOUS;
        }

        Set<String> allowed = Set.copyOf(policy.allowedMimeTypes());
        Set<String> expected = EXTENSION_EXPECTED_MIMES.getOrDefault(normalizeExtension(extension), Set.of());

        if (expected.contains(normalizedMime) || allowed.contains(normalizedMime)) {
            return MimeClassification.MATCH;
        }

        if (isConfidentMismatch(normalizedMime)) {
            return MimeClassification.CONFIDENT_MISMATCH;
        }

        if (normalizedMime.startsWith("audio/")) {
            return MimeClassification.AMBIGUOUS;
        }

        if (!allowed.contains(normalizedMime)) {
            return MimeClassification.CONFIDENT_MISMATCH;
        }

        return MimeClassification.AMBIGUOUS;
    }

    private static boolean isConfidentMismatch(String normalizedMime) {
        return normalizedMime.startsWith("application/x-msdownload")
                || normalizedMime.startsWith("application/vnd.microsoft")
                || normalizedMime.startsWith("application/x-executable")
                || normalizedMime.startsWith("application/x-dosexec")
                || normalizedMime.startsWith("application/x-msdos-program")
                || normalizedMime.equals("application/zip")
                || normalizedMime.startsWith("text/")
                || normalizedMime.startsWith("image/")
                || normalizedMime.startsWith("video/");
    }

    private static String normalizeMime(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        return value.split(";")[0].trim().toLowerCase(Locale.ROOT);
    }

    private static String normalizeExtension(String extension) {
        if (extension == null || extension.isBlank()) {
            return "";
        }
        String normalized = extension.trim().toLowerCase(Locale.ROOT);
        return normalized.startsWith(".") ? normalized : "." + normalized;
    }

    private static Tika createTika() {
        try {
            return new Tika(new TikaConfig());
        } catch (Exception ex) {
            log.warn("event=UPLOAD_VALIDATION_MIME_FALLBACK reason=library_unavailable errorCode={}", ex.getClass().getSimpleName());
            return null;
        }
    }
}
