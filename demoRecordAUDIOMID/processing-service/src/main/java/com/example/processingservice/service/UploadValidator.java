package com.example.processingservice.service;

import com.example.processingservice.config.Epic2FeatureFlags;
import com.example.processingservice.config.UploadValidationPolicy;
import com.example.processingservice.controller.ErrorCode;
import com.example.processingservice.controller.UploadValidationException;
import java.util.Locale;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.multipart.MultipartFile;

@Component
public class UploadValidator {

    private final UploadValidationPolicy policy;
    private final Epic2FeatureFlags featureFlags;

    public UploadValidator(UploadValidationPolicy policy, Epic2FeatureFlags featureFlags) {
        this.policy = policy;
        this.featureFlags = featureFlags;
    }

    public void validateIfStrict(MultipartFile file, String originalFilename) {
        if (!featureFlags.isUploadValidationStrict()) {
            return;
        }

        if (file == null || file.isEmpty()) {
            throw new UploadValidationException(ErrorCode.UPLOAD_EMPTY_FILE, HttpStatus.BAD_REQUEST);
        }

        if (file.getSize() > policy.maxUploadBytes()) {
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
        if (!policy.allowedExtensions().contains(normalizedExtension)) {
            throw new UploadValidationException(ErrorCode.UPLOAD_UNSUPPORTED_FORMAT, HttpStatus.UNSUPPORTED_MEDIA_TYPE);
        }
    }
}
