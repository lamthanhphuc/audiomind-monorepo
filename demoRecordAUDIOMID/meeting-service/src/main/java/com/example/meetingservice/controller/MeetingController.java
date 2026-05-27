package com.example.meetingservice.controller;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingService;
import lombok.RequiredArgsConstructor;

import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.util.StringUtils;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Set;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

@CrossOrigin(origins = "${CORS_ALLOWED_ORIGINS:http://localhost:5173}")
@RestController
@RequestMapping("/meetings")
@RequiredArgsConstructor
public class MeetingController {
    private static final Logger log = LoggerFactory.getLogger(MeetingController.class);

    private static final long MAX_UPLOAD_BYTES = 100L * 1024L * 1024L;
    private static final Set<String> ALLOWED_EXTENSIONS = Set.of(".wav", ".mp3", ".m4a", ".ogg", ".aac", ".flac", ".webm", ".mp4");
    private static final Set<String> ALLOWED_UPLOAD_LANGUAGES = Set.of("vi", "en", "multi");

    private final MeetingService meetingService;

    private final String uploadDir = "uploads/";

    @PostMapping("/upload")
    public Meeting upload(
            @RequestParam String title,
            @RequestParam MultipartFile file,
            @RequestParam(required = false) String language,
            Authentication authentication) {

        if (file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "File is empty");
        }
        if (file.getSize() > MAX_UPLOAD_BYTES) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "File exceeds 100MB limit");
        }

        Path uploadPath = Paths.get(System.getProperty("user.dir"), uploadDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(uploadPath);
        } catch (IOException createError) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Unable to prepare upload directory", createError);
        }

        String originalName = Objects.requireNonNullElse(file.getOriginalFilename(), "audio-upload.bin");
        String cleanedFileName = StringUtils.cleanPath(originalName);
        String extension = StringUtils.getFilenameExtension(cleanedFileName);
        String normalizedExtension = extension == null ? "" : "." + extension.toLowerCase();
        if (!ALLOWED_EXTENSIONS.contains(normalizedExtension)) {
            throw new ResponseStatusException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "Unsupported file type");
        }
        if (cleanedFileName.contains("..")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid file name");
        }

        String storedFileName = UUID.randomUUID().toString() + normalizedExtension;
        Path targetFile = uploadPath.resolve(storedFileName).normalize();
        if (!targetFile.startsWith(uploadPath)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid upload path");
        }

        try {
            file.transferTo(targetFile.toFile());
        } catch (IOException transferError) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Unable to persist uploaded file", transferError);
        }

        UserPrincipal principal = requirePrincipal(authentication);
        String effectiveLanguage = normalizeUploadLanguage(language);
        log.info(
                "event=UPLOAD_REQUEST_RECEIVED traceId={} requestId={} source=upload path=/meetings/upload",
                MDC.get("traceId"),
                resolveRequestId()
        );
        log.info(
                "event=UPLOAD_LANGUAGE_EFFECTIVE traceId={} requestId={} source=upload requestedLanguage={} effectiveLanguage={}",
                MDC.get("traceId"),
                resolveRequestId(),
                language == null ? "" : language,
                effectiveLanguage
        );
        Meeting saved = meetingService.saveMeeting(title, targetFile.toString(), principal.userId(), cleanedFileName, effectiveLanguage);
        log.info(
                "event=REQUEST_COMPLETED traceId={} requestId={} meetingId={} path=/meetings/upload",
                MDC.get("traceId"),
                resolveRequestId(),
                saved.getId()
        );
        return saved;
    }

    @GetMapping("/{id}")
    public Meeting getById(@PathVariable Long id, Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        log.info(
                "event=REQUEST_RECEIVED traceId={} requestId={} meetingId={} path=/meetings/{}",
                MDC.get("traceId"),
                resolveRequestId(),
                id,
                id
        );
        return meetingService.findByIdForOwner(id, principal.userId());
    }

    @GetMapping
    public List<Meeting> getRecentMeetings(Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        return meetingService.findRecentMeetingsForOwner(principal.userId());
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }

    private String normalizeUploadLanguage(String language) {
        if (language == null) {
            return "vi";
        }
        String normalized = language.trim().toLowerCase();
        if (ALLOWED_UPLOAD_LANGUAGES.contains(normalized)) {
            return normalized;
        }
        return "vi";
    }

    private String resolveRequestId() {
        String requestId = MDC.get("requestId");
        if (requestId != null && !requestId.isBlank()) {
            return requestId;
        }
        String traceId = MDC.get("traceId");
        return traceId == null ? "" : traceId;
    }
}
