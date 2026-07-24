package com.example.userservice.controller;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserApiKey;
import com.example.userservice.google.GoogleOAuthError;
import com.example.userservice.google.GoogleOAuthException;
import com.example.userservice.google.GoogleOAuthProperties;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserApiKeyRepository;
import com.example.userservice.service.AuditEventService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/api-keys")
@RequiredArgsConstructor
public class InternalApiKeyController {

    private final UserApiKeyRepository userApiKeyRepository;
    private final UserAccountRepository userAccountRepository;
    private final GoogleOAuthProperties properties;
    private final AuditEventService auditEventService;

    @PostMapping("/introspect")
    public Map<String, Object> introspect(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String serviceToken,
            @Valid @RequestBody IntrospectRequest request
    ) {
        if (!constantTimeEquals(serviceToken, properties.getInternalServiceToken())) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_INTERNAL_CALL_FORBIDDEN);
        }
        return userApiKeyRepository.findByKeyHashAndRevokedAtIsNull(sha256Hex(request.apiKey()))
                .flatMap(key -> userAccountRepository.findById(key.getUserId()).map(user -> view(key, user, request)))
                .orElseGet(() -> Map.of("active", false));
    }

    private Map<String, Object> view(UserApiKey key, UserAccount user, IntrospectRequest request) {
        key.setLastUsedAt(Instant.now());
        userApiKeyRepository.save(key);
        auditEventService.record(
                user.getId(),
                "API_KEY_USED",
                "USER_API_KEY",
                String.valueOf(key.getId()),
                "API key used",
                Map.of(
                        "callerService", request.callerService(),
                        "method", request.method(),
                        "path", request.path()
                )
        );
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("active", true);
        out.put("apiKeyId", key.getId());
        out.put("userId", user.getId());
        out.put("username", user.getUsername());
        out.put("role", user.getRole());
        out.put("plan", user.getPlan());
        out.put("scopes", key.getScopes());
        return out;
    }

    private static boolean constantTimeEquals(String left, String right) {
        if (left == null || right == null || right.isBlank()) {
            return false;
        }
        return MessageDigest.isEqual(left.getBytes(StandardCharsets.UTF_8), right.getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException("Could not hash API key", ex);
        }
    }

    public record IntrospectRequest(
            @NotBlank String apiKey,
            String callerService,
            String method,
            String path
    ) {
    }
}
