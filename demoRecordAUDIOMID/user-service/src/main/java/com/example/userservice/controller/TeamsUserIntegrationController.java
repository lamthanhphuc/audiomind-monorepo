package com.example.userservice.controller;

import com.example.userservice.controller.dto.TeamsImportRecordingResponse;
import com.example.userservice.controller.dto.TeamsOperationResponse;
import com.example.userservice.controller.dto.TeamsRecordingsResponse;
import com.example.userservice.controller.dto.TeamsStatusResponse;
import com.example.userservice.security.UserPrincipal;
import com.example.userservice.teams.TeamsGrantService;
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
@RequestMapping("/users/me/teams")
public class TeamsUserIntegrationController {

    private final TeamsGrantService teamsGrantService;

    public TeamsUserIntegrationController(TeamsGrantService teamsGrantService) {
        this.teamsGrantService = teamsGrantService;
    }

    @GetMapping("/status")
    public TeamsStatusResponse status(Authentication authentication) {
        return teamsGrantService.status(requirePrincipal(authentication).userId());
    }

    @DeleteMapping("/grant")
    public TeamsOperationResponse revokeGrant(Authentication authentication) {
        teamsGrantService.revokeGrant(requirePrincipal(authentication).userId());
        return new TeamsOperationResponse(true);
    }

    @GetMapping("/recordings")
    public TeamsRecordingsResponse recordings(
            Authentication authentication,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        return teamsGrantService.listRecordings(requirePrincipal(authentication).userId(), from, to);
    }

    @PostMapping("/recordings/import")
    public TeamsImportRecordingResponse importRecording(
            Authentication authentication,
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
            @RequestBody Map<String, Object> body) {
        UserPrincipal principal = requirePrincipal(authentication);
        String meetingUuid = stringValue(body == null ? null : body.get("meetingUuid"), body == null ? null : body.get("meeting_uuid"));
        String recordingFileId = stringValue(body == null ? null : body.get("recordingFileId"), body == null ? null : body.get("recording_file_id"));
        String title = stringValue(body == null ? null : body.get("title"));
        String language = stringValue(body == null ? null : body.get("language"));
        return teamsGrantService.importRecording(
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
