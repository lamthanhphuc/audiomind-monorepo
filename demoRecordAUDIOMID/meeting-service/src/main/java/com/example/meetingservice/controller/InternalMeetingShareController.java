package com.example.meetingservice.controller;

import com.example.meetingservice.service.MeetingShareService;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/internal/meeting-shares")
@RequiredArgsConstructor
public class InternalMeetingShareController {

    private final MeetingShareService meetingShareService;

    @Value("${google.integration.internal-service-token:}")
    private String internalServiceToken;

    @PostMapping("/accept-pending")
    public Map<String, Object> acceptPending(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,
            @RequestBody AcceptPendingRequest request
    ) {
        requireInternalToken(token);
        if (request == null || request.userId() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "User id is required");
        }
        if (request.email() == null || request.email().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Email is required");
        }
        return meetingShareService.acceptPendingInvitesForUser(request.userId(), request.email());
    }

    private void requireInternalToken(String token) {
        if (internalServiceToken == null || internalServiceToken.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Internal token not configured");
        }
        if (token == null || token.isBlank() || !internalServiceToken.equals(token)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
    }

    public record AcceptPendingRequest(
            Long userId,
            String email
    ) {
    }
}
