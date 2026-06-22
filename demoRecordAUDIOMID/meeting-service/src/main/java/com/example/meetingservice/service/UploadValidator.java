package com.example.meetingservice.service;

import com.example.meetingservice.config.Epic2FeatureFlags;
import com.example.meetingservice.config.UploadValidationPolicy;
import com.example.meetingservice.controller.ErrorCode;
import com.example.meetingservice.controller.UploadValidationException;
import java.util.Locale;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.multipart.MultipartFile;

@Component
public class UploadValidator {

    private static final Set<String> LEGACY_EXTENSIONS = Set.of(
            ".wav", ".mp3", ".m4a", ".ogg", ".aac", ".flac", ".webm", ".mp4"
    );
    private static final long LEGACY_MAX_BYTES = 100L * 1024L * 1024L;

    private final UploadValidationPolicy policy;
    private final Epic2FeatureFlags featureFlags;

    public UploadValidator(UploadValidationPolicy policy, Epic2FeatureFlags featureFlags) {
        this.policy = policy;
        this.featureFlags = featureFlags;
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
    }
}
