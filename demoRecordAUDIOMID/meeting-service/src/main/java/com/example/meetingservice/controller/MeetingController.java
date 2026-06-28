package com.example.meetingservice.controller;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.controller.dto.CreateScheduledMeetingRequest;
import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingService;
import com.example.meetingservice.service.UploadValidator;
import lombok.RequiredArgsConstructor;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
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
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import org.springframework.security.core.Authentication;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;

@CrossOrigin(origins = "${CORS_ALLOWED_ORIGINS:http://localhost:5173}")
@RestController
@RequestMapping("/meetings")
@RequiredArgsConstructor
public class MeetingController {
    private static final Logger log = LoggerFactory.getLogger(MeetingController.class);

    private static final Set<String> ALLOWED_UPLOAD_LANGUAGES = Set.of("vi", "en", "multi");

    private final MeetingService meetingService;
    private final UploadValidator uploadValidator;

    private final String uploadDir = "uploads/";

    @PostMapping("/upload")
    public Map<String, Object> upload(
            @RequestParam String title,
            @RequestParam MultipartFile file,
            @RequestParam(required = false) String language,
            Authentication authentication) {

        uploadValidator.validate(file, file.getOriginalFilename(), MDC.get("traceId"));

        String originalName = Objects.requireNonNullElse(file.getOriginalFilename(), "audio-upload.bin");
        String cleanedFileName = StringUtils.cleanPath(originalName);
        String extension = StringUtils.getFilenameExtension(cleanedFileName);
        String normalizedExtension = extension == null ? "" : "." + extension.toLowerCase();

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

    @PostMapping("/realtime")
    public Map<String, Object> createRealtimeMeeting(
            @RequestBody(required = false) CreateRealtimeMeetingRequest request,
            Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        String title = request == null || request.title() == null || request.title().isBlank()
                ? "Live recording session"
                : request.title().trim();
        String effectiveLanguage = normalizeUploadLanguage(request == null ? null : request.language());

        Meeting saved = meetingService.saveMeeting(
                title,
                "",
                principal.userId(),
                "realtime",
                effectiveLanguage,
                null,
                0L,
                MeetingService.MEETING_STATUS_PROCESSING
        );
        log.info(
                "event=REALTIME_MEETING_CREATED traceId={} requestId={} ownerUserId={} meetingId={} source=realtime",
                MDC.get("traceId"),
                resolveRequestId(),
                principal.userId(),
                saved.getId()
        );

        Map<String, Object> response = buildUploadResponse(saved, false, false, null, saved.getStatus());
        response.put("source", "realtime");
        return response;
    }

    @PostMapping("/scheduled")
    public Meeting createScheduledMeeting(
            @RequestBody CreateScheduledMeetingRequest request,
            Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        if (request == null || request.title() == null || request.title().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Title is required");
        }
        if (request.startDateTime() == null || request.endDateTime() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Start and end times are required");
        }
        try {
            OffsetDateTime startAt = OffsetDateTime.parse(request.startDateTime());
            OffsetDateTime endAt = OffsetDateTime.parse(request.endDateTime());
            String timeZone = request.timeZone() == null || request.timeZone().isBlank()
                    ? "Asia/Ho_Chi_Minh"
                    : request.timeZone().trim();
            ZoneId.of(timeZone);
            Meeting saved = meetingService.saveScheduledMeeting(
                    request.title(),
                    principal.userId(),
                    normalizeUploadLanguage(request.language()),
                    startAt,
                    endAt,
                    timeZone);
            log.info(
                    "event=SCHEDULED_MEETING_CREATED traceId={} requestId={} ownerUserId={} meetingId={}",
                    MDC.get("traceId"), resolveRequestId(), principal.userId(), saved.getId());
            return saved;
        } catch (DateTimeParseException | java.time.zone.ZoneRulesException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid scheduled date, offset, or time zone");
        }
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
        return meetingService.findByIdForUser(id, principal.userId());
    }

    @GetMapping("/{id}/audio")
    public ResponseEntity<Resource> streamMeetingAudio(@PathVariable Long id, Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        Meeting meeting = meetingService.findByIdForUser(id, principal.userId());
        String audioPath = meeting.getAudioPath();
        if (!StringUtils.hasText(audioPath)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Meeting has no audio file");
        }

        Path file = Paths.get(audioPath).toAbsolutePath().normalize();
        if (!Files.isRegularFile(file)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Audio file not found");
        }

        Path uploadRoot = Paths.get(System.getProperty("user.dir"), uploadDir).toAbsolutePath().normalize();
        if (!file.startsWith(uploadRoot)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Invalid audio path");
        }

        String filename = StringUtils.hasText(meeting.getOriginalFileName())
                ? meeting.getOriginalFileName()
                : file.getFileName().toString();
        String contentType;
        try {
            contentType = Files.probeContentType(file);
        } catch (IOException probeError) {
            contentType = null;
        }
        if (!StringUtils.hasText(contentType)) {
            contentType = MediaType.APPLICATION_OCTET_STREAM_VALUE;
        }

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "inline; filename=\"" + filename + "\"")
                .contentType(MediaType.parseMediaType(contentType))
                .body(new FileSystemResource(file));
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
        List<Meeting> meetings = meetingService.findMeetingsForUser(
                principal.userId(),
                query,
                status,
                language,
                sort
        );
        Long userId = principal.userId();
        for (Meeting meeting : meetings) {
            meeting.setSharedWithMe(
                    meeting.getOwnerUserId() != null && !meeting.getOwnerUserId().equals(userId)
            );
        }
        return meetings;
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
        response.put("scheduledStartAt", meeting.getScheduledStartAt());
        response.put("scheduledEndAt", meeting.getScheduledEndAt());
        response.put("scheduledTimezone", meeting.getScheduledTimezone());
        response.put("duplicate", duplicate);
        response.put("reused", reused);
        response.put("existingMeetingId", existingMeetingId);
        return response;
    }

    private record RenameMeetingRequest(String title) {
    }

    private record UpdateMeetingStatusRequest(String status) {
    }

    public record CreateRealtimeMeetingRequest(String title, String language) {
    }
}
