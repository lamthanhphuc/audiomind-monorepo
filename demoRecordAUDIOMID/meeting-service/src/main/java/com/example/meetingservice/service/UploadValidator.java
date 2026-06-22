package com.example.meetingservice.service;

import com.example.meetingservice.config.Epic2FeatureFlags;
import com.example.meetingservice.config.UploadValidationPolicy;
import com.example.meetingservice.controller.ErrorCode;
import com.example.meetingservice.controller.UploadValidationException;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.multipart.MultipartFile;

@Component
public class UploadValidator {

    private static final int MIME_SNIFF_BYTES = 64 * 1024;
    private static final Set<String> LEGACY_EXTENSIONS = Set.of(
            ".wav", ".mp3", ".m4a", ".ogg", ".aac", ".flac", ".webm", ".mp4"
    );
    private static final long LEGACY_MAX_BYTES = 100L * 1024L * 1024L;

    private final UploadValidationPolicy policy;
    private final Epic2FeatureFlags featureFlags;
    private final MimeSniffer mimeSniffer;

    public UploadValidator(
            UploadValidationPolicy policy,
            Epic2FeatureFlags featureFlags,
            MimeSniffer mimeSniffer
    ) {
        this.policy = policy;
        this.featureFlags = featureFlags;
        this.mimeSniffer = mimeSniffer;
    }

    public void validate(MultipartFile file, String originalFilename) {
        if (file == null || file.isEmpty()) {
            throw new UploadValidationException(ErrorCode.UPLOAD_EMPTY_FILE, HttpStatus.BAD_REQUEST);
        }

        long maxBytes = featureFlags.isUploadValidationStrict()
                ? policy.maxUploadBytes()
                : LEGACY_MAX_BYTES;
        if (file.getSize() > maxBytes) {
            throw new UploadValidationException(ErrorCode.UPLOAD_TOO_LARGE, HttpStatus.PAYLOAD_TOO_LARGE);
        }

        String cleanedFileName = StringUtils.cleanPath(
                originalFilename == null || originalFilename.isBlank() ? "audio-upload.bin" : originalFilename
        );
        if (cleanedFileName.contains("..")) {
            throw new UploadValidationException(ErrorCode.UPLOAD_INVALID_FILENAME, HttpStatus.BAD_REQUEST);
        }

        String extension = StringUtils.getFilenameExtension(cleanedFileName);
        String normalizedExtension = extension == null ? "" : "." + extension.toLowerCase(Locale.ROOT);
        Set<String> allowed = featureFlags.isUploadValidationStrict()
                ? policy.allowedExtensions()
                : LEGACY_EXTENSIONS;
        if (!allowed.contains(normalizedExtension)) {
            throw new UploadValidationException(ErrorCode.UPLOAD_UNSUPPORTED_FORMAT, HttpStatus.UNSUPPORTED_MEDIA_TYPE);
        }

        if (featureFlags.isMimeSniffEnabled()) {
            validateMime(file, normalizedExtension);
        }
    }

    private void validateMime(MultipartFile file, String normalizedExtension) {
        try {
            byte[] sample = readSample(file);
            String contentHashPrefix = contentHashPrefix(sample);
            MimeSniffer.MimeSniffResult result = mimeSniffer.sniff(
                    sample,
                    normalizedExtension,
                    file.getSize(),
                    contentHashPrefix
            );
            if (result.classification() == MimeSniffer.MimeClassification.CONFIDENT_MISMATCH) {
                throw new UploadValidationException(ErrorCode.UPLOAD_MIME_MISMATCH, HttpStatus.UNSUPPORTED_MEDIA_TYPE);
            }
        } catch (IOException readError) {
            // Best-effort sniff: fall back to extension allowlist when sample cannot be read.
        }
    }

    private static byte[] readSample(MultipartFile file) throws IOException {
        int sampleSize = (int) Math.min(file.getSize(), MIME_SNIFF_BYTES);
        if (sampleSize <= 0) {
            return new byte[0];
        }
        try (InputStream input = file.getInputStream()) {
            return input.readNBytes(sampleSize);
        }
    }

    private static String contentHashPrefix(byte[] sample) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(sample);
            return HexFormat.of().formatHex(hash, 0, 8);
        } catch (NoSuchAlgorithmException ex) {
            return Integer.toHexString(java.util.Arrays.hashCode(sample));
        }
    }
}
