package com.example.userservice.controller;

import com.example.userservice.controller.dto.InternalGoogleAccessTokenRequest;
import com.example.userservice.controller.dto.InternalGoogleAccessTokenResponse;
import com.example.userservice.google.GoogleGrantService;
import com.example.userservice.google.GoogleOAuthError;
import com.example.userservice.google.GoogleOAuthException;
import com.example.userservice.google.GoogleOAuthProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Set;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/internal/google")
public class InternalGoogleController {

    private static final Set<String> ALLOWED_CALLERS = Set.of("meeting-service", "processing-service");
    private final GoogleGrantService grantService;
    private final GoogleOAuthProperties properties;

    public InternalGoogleController(
            GoogleGrantService grantService,
            GoogleOAuthProperties properties) {
        this.grantService = grantService;
        this.properties = properties;
    }

    @PostMapping("/access-token")
    public InternalGoogleAccessTokenResponse accessToken(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String serviceToken,
            @RequestBody InternalGoogleAccessTokenRequest request) {
        properties.requireGrantConfigured();
        if (request == null
                || request.userId() == null
                || !ALLOWED_CALLERS.contains(request.callerService())
                || !constantTimeEquals(serviceToken, properties.getInternalServiceToken())) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_INTERNAL_CALL_FORBIDDEN);
        }
        return grantService.accessToken(request.userId(), request.requiredScopes());
    }

    private boolean constantTimeEquals(String left, String right) {
        if (left == null || right == null) {
            return false;
        }
        return MessageDigest.isEqual(
                left.getBytes(StandardCharsets.UTF_8),
                right.getBytes(StandardCharsets.UTF_8));
    }
}
