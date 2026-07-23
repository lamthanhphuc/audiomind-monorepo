package com.example.userservice.controller;

import com.example.userservice.security.UserPrincipal;
import com.example.userservice.service.AuditEventService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequiredArgsConstructor
public class AuditController {

    private final AuditEventService auditEventService;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    @GetMapping("/api/admin/audit-events")
    public Map<String, Object> list(
            Authentication authentication,
            @RequestParam(required = false) Long actorUserId,
            @RequestParam(required = false) String eventType,
            @RequestParam(required = false) Instant from,
            @RequestParam(required = false) Instant to,
            @RequestParam(defaultValue = "100") int limit
    ) {
        requireAdmin(authentication);
        return Map.of("items", auditEventService.list(actorUserId, eventType, from, to, limit));
    }

    @PostMapping("/internal/audit-events")
    public Map<String, Object> createInternal(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,
            @Valid @RequestBody CreateAuditEventRequest request
    ) {
        requireInternalToken(token);
        return auditEventService.toView(auditEventService.record(
                request.actorUserId(),
                request.eventType(),
                request.targetType(),
                request.targetId(),
                request.summary(),
                request.metadata() == null ? Map.of() : request.metadata()
        ));
    }

    private static UserPrincipal requireAdmin(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        if (!"ADMIN".equalsIgnoreCase(principal.role())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Forbidden");
        }
        return principal;
    }

    private void requireInternalToken(String token) {
        if (internalServiceToken == null || internalServiceToken.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Internal token not configured");
        }
        if (token == null || token.isBlank() || !internalServiceToken.equals(token)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
    }

    public record CreateAuditEventRequest(
            Long actorUserId,
            @NotBlank String eventType,
            String targetType,
            String targetId,
            @NotBlank String summary,
            Map<String, Object> metadata
    ) {
    }
}
