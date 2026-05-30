package com.example.meetingservice.controller;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingService;
import lombok.RequiredArgsConstructor;

import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.util.StringUtils;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
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
    public Map<String, Object> upload(
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

        byte[] fileBytes;
        try {
            fileBytes = file.getBytes();
        } catch (IOException readError) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Unable to read uploaded file", readError);
        }

        UserPrincipal principal = requirePrincipal(authentication);
        String audioHash = computeAudioHash(fileBytes);
        MeetingService.DuplicateMatch duplicate = meetingService.findActiveDuplicateForOwner(principal.userId(), audioHash)
                .orElse(null);
        if (duplicate != null) {
            log.info(
                    "event=UPLOAD_DUPLICATE_REUSED traceId={} requestId={} ownerUserId={} meetingId={} duplicateStatus={}",
                    MDC.get("traceId"),
                    resolveRequestId(),
                    principal.userId(),
                    duplicate.meeting().getId(),
                    duplicate.status()
            );
            return buildUploadResponse(
                    duplicate.meeting(),
                    true,
                    duplicate.reused(),
                    duplicate.meeting().getId(),
                    duplicate.status()
            );
        }

        Path uploadPath = Paths.get(System.getProperty("user.dir"), uploadDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(uploadPath);
        } catch (IOException createError) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Unable to prepare upload directory", createError);
        }

        String storedFileName = UUID.randomUUID() + normalizedExtension;
        Path targetFile = uploadPath.resolve(storedFileName).normalize();
        if (!targetFile.startsWith(uploadPath)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid upload path");
        }

        try {
            Files.write(targetFile, fileBytes);
        } catch (IOException writeError) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Unable to persist uploaded file", writeError);
        }

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
        Meeting saved = meetingService.saveMeeting(
                title,
                targetFile.toString(),
                principal.userId(),
                cleanedFileName,
                effectiveLanguage,
                audioHash,
                file.getSize(),
                MeetingService.MEETING_STATUS_PROCESSING
        );
        log.info(
                "event=REQUEST_COMPLETED traceId={} requestId={} meetingId={} path=/meetings/upload",
                MDC.get("traceId"),
                resolveRequestId(),
                saved.getId()
        );
        return buildUploadResponse(saved, false, false, null, saved.getStatus());
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
    public List<Meeting> getMeetings(
            @RequestParam(required = false) String query,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String language,
            @RequestParam(required = false) String sort,
            Authentication authentication
    ) {
        UserPrincipal principal = requirePrincipal(authentication);
        return meetingService.findMeetingsForOwner(principal.userId(), query, status, language, sort);
    }

    @PatchMapping("/{id}")
    public Meeting renameMeeting(@PathVariable Long id, @RequestBody RenameMeetingRequest request, Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        if (request == null || request.title() == null || request.title().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Title is required");
        }
        return meetingService.renameMeetingForOwner(id, principal.userId(), request.title());
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> softDeleteMeeting(@PathVariable Long id, Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        Meeting deleted = meetingService.softDeleteForOwner(id, principal.userId());
        return Map.of(
                "id", deleted.getId(),
                "deleted", true
        );
    }

    @PatchMapping("/{id}/status")
    public Meeting updateMeetingStatus(
            @PathVariable Long id,
            @RequestBody UpdateMeetingStatusRequest request,
            Authentication authentication
    ) {
        UserPrincipal principal = requirePrincipal(authentication);
        if (request == null || request.status() == null || request.status().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Status is required");
        }
        return meetingService.updateMeetingStatusForOwner(id, principal.userId(), request.status());
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

    private String computeAudioHash(byte[] payload) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(payload == null ? new byte[0] : payload));
        } catch (NoSuchAlgorithmException ex) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Unable to compute audio hash", ex);
        }
    }

    private Map<String, Object> buildUploadResponse(
            Meeting meeting,
            boolean duplicate,
            boolean reused,
            Long existingMeetingId,
            String status
    ) {
        Map<String, Object> response = new HashMap<>();
        response.put("id", meeting.getId());
        response.put("title", meeting.getTitle());
        response.put("audioPath", meeting.getAudioPath());
        response.put("createdAt", meeting.getCreatedAt());
        response.put("originalFileName", meeting.getOriginalFileName());
        response.put("ownerUserId", meeting.getOwnerUserId());
        response.put("language", meeting.getLanguage());
        response.put("fileSize", meeting.getFileSize());
        response.put("status", meetingService.normalizeMeetingStatus(status));
        response.put("duplicate", duplicate);
        response.put("reused", reused);
        response.put("existingMeetingId", existingMeetingId);
        return response;
    }

    private record RenameMeetingRequest(String title) {
    }

    private record UpdateMeetingStatusRequest(String status) {
    }
}
