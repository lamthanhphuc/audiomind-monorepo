package com.example.meetingservice.controller;

import com.example.meetingservice.controller.dto.PageResponse;
import com.example.meetingservice.controller.dto.SubjectMeetingResponse;
import com.example.meetingservice.service.SubjectService;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Internal subject membership APIs for service-to-service callers (AI worker).
 *
 * <p>Security filter chain keeps {@code /internal/**} as {@code permitAll}; this controller
 * enforces {@code X-Internal-Service-Token} (same pattern as user-service
 * {@code InternalQuotaController} and {@link InternalMeetingShareController}).
 */
@RestController
@RequestMapping("/internal/subjects")
@RequiredArgsConstructor
public class InternalSubjectController {

    private final SubjectService subjectService;

    @Value("${app.internal.service-token:${google.integration.internal-service-token:}}")
    private String internalServiceToken;

    @GetMapping("/{subjectId}/meetings")
    public PageResponse<SubjectMeetingResponse> listMeetings(
            @PathVariable Long subjectId,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer pageSize,
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,
            @RequestHeader(name = "X-Owner-User-Id", required = false) String ownerUserIdHeader
    ) {
        requireInternalToken(token);
        Long ownerUserId = requireOwnerUserId(ownerUserIdHeader);
        // SubjectService.listMeetings → requireOwnedSubject: missing or wrong owner → 404
        return subjectService.listMeetings(subjectId, ownerUserId, page, pageSize);
    }

    private void requireInternalToken(String token) {
        if (internalServiceToken == null || internalServiceToken.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Internal token not configured");
        }
        if (token == null || token.isBlank() || !internalServiceToken.equals(token)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
    }

    private static Long requireOwnerUserId(String ownerUserIdHeader) {
        if (ownerUserIdHeader == null || ownerUserIdHeader.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "X-Owner-User-Id is required");
        }
        try {
            long ownerUserId = Long.parseLong(ownerUserIdHeader.trim());
            if (ownerUserId < 1) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "X-Owner-User-Id must be a positive id");
            }
            return ownerUserId;
        } catch (NumberFormatException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "X-Owner-User-Id must be a number");
        }
    }
}
