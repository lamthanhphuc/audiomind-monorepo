package com.example.userservice.controller;

import com.example.userservice.controller.dto.ZoomImportRecordingResponse;
import com.example.userservice.controller.dto.ZoomOperationResponse;
import com.example.userservice.controller.dto.ZoomRecordingsResponse;
import com.example.userservice.controller.dto.ZoomStatusResponse;
import com.example.userservice.security.UserPrincipal;
import com.example.userservice.zoom.ZoomGrantService;
import java.time.LocalDate;
import java.util.Map;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/users/me/zoom")
public class ZoomUserIntegrationController {

    private final ZoomGrantService zoomGrantService;

    public ZoomUserIntegrationController(ZoomGrantService zoomGrantService) {
        this.zoomGrantService = zoomGrantService;
    }

    @GetMapping("/status")
    public ZoomStatusResponse status(Authentication authentication) {
        return zoomGrantService.status(requirePrincipal(authentication).userId());
    }

    @DeleteMapping("/grant")
    public ZoomOperationResponse revokeGrant(Authentication authentication) {
        zoomGrantService.revokeGrant(requirePrincipal(authentication).userId());
        return new ZoomOperationResponse(true);
    }

    @GetMapping("/recordings")
    public ZoomRecordingsResponse recordings(
            Authentication authentication,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        return zoomGrantService.listRecordings(requirePrincipal(authentication).userId(), from, to);
    }

    @PostMapping("/recordings/import")
    public ZoomImportRecordingResponse importRecording(
            Authentication authentication,
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestBody Map<String, Object> body) {
        UserPrincipal principal = requirePrincipal(authentication);
        String meetingUuid = stringValue(body == null ? null : body.get("meetingUuid"), body == null ? null : body.get("meeting_uuid"));
        String recordingFileId = stringValue(body == null ? null : body.get("recordingFileId"), body == null ? null : body.get("recording_file_id"));
        String title = stringValue(body == null ? null : body.get("title"));
        String language = stringValue(body == null ? null : body.get("language"));
        return zoomGrantService.importRecording(
                principal.userId(),
                authorization,
                meetingUuid,
                recordingFileId,
                title,
                language
        );
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }

    private static String stringValue(Object... values) {
        for (Object value : values) {
            if (value != null && !String.valueOf(value).trim().isBlank()) {
                return String.valueOf(value).trim();
            }
        }
        return null;
    }
}
