package com.example.userservice.service;

import com.example.userservice.client.PendingMeetingShareClient;
import com.example.userservice.controller.dto.AuthResponse;
import com.example.userservice.controller.dto.LoginRequest;
import com.example.userservice.controller.dto.RegisterRequest;
import com.example.userservice.controller.dto.RegisterResponse;
import com.example.userservice.controller.dto.UserPreferencesRequest;
import com.example.userservice.controller.dto.UserProfileResponse;
import com.example.userservice.controller.dto.UserProfileUpdateRequest;
import com.example.userservice.entity.UserAccount;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.security.JwtUtil;
import com.example.userservice.security.TokenBlacklistStore;
import com.example.userservice.security.UserPrincipal;
import io.jsonwebtoken.Claims;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;
import java.time.Instant;

@Service
@RequiredArgsConstructor
public class UserService {

    private static final Logger log = LoggerFactory.getLogger(UserService.class);

    private final UserAccountRepository userAccountRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtUtil jwtUtil;
    private final TokenBlacklistStore tokenBlacklistStore;
    private final PendingMeetingShareClient pendingMeetingShareClient;
    private final UserPlanService userPlanService;
    private final AuditEventService auditEventService;
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${app.security.jwt.access-expiration-seconds}")
    private long accessExpirationSeconds;

    @Transactional
    public RegisterResponse register(RegisterRequest request) {
        if (userAccountRepository.existsByUsername(request.username())) {
            throw new IllegalArgumentException("Username already exists");
        }
        if (userAccountRepository.existsByEmail(request.email())) {
            throw new IllegalArgumentException("Email already exists");
        }

        UserAccount user = new UserAccount();
        user.setUsername(request.username());
        user.setEmail(request.email());
        user.setPasswordHash(passwordEncoder.encode(request.password()));
        userPlanService.applyNewUserTrial(user);

        UserAccount saved = userAccountRepository.save(user);
        pendingMeetingShareClient.acceptPendingInvites(saved.getId(), saved.getEmail());
        log.info(
                "event=REQUEST_COMPLETED traceId={} requestId={} path=/api/users/register userId={}",
                MDC.get("traceId"),
                resolveRequestId(),
                saved.getId()
        );

        return new RegisterResponse(saved.getId());
    }

    @Transactional
    public AuthResponse login(LoginRequest request) {
        UserAccount user = userAccountRepository.findByUsername(request.username())
                .orElseThrow(() -> new BadCredentialsException("Invalid username or password"));

        if (user.getPasswordHash() == null || !passwordEncoder.matches(request.password(), user.getPasswordHash())) {
            throw new BadCredentialsException("Invalid username or password");
        }

        pendingMeetingShareClient.acceptPendingInvites(user.getId(), user.getEmail());

        UserAccount currentUser = userPlanService.refreshExpiredPlan(user);
        String effectivePlan = userPlanService.resolveEffectivePlan(currentUser);
        String accessToken = jwtUtil.createAccessToken(
                currentUser.getId(),
                currentUser.getUsername(),
                currentUser.getRole(),
                effectivePlan
        );
        log.info(
                "event=REQUEST_COMPLETED traceId={} requestId={} path=/api/users/login userId={}",
                MDC.get("traceId"),
                resolveRequestId(),
                user.getId()
        );

        return new AuthResponse(currentUser.getId(), accessToken, accessExpirationSeconds);
    }

    @Transactional
    public AuthResponse refreshAccessToken(UserPrincipal principal) {
        UserAccount user = userAccountRepository.findById(principal.userId())
                .orElseThrow(() -> new BadCredentialsException("User not found"));

        UserAccount currentUser = userPlanService.refreshExpiredPlan(user);
        String effectivePlan = userPlanService.resolveEffectivePlan(currentUser);
        String accessToken = jwtUtil.createAccessToken(
                currentUser.getId(),
                currentUser.getUsername(),
                currentUser.getRole(),
                effectivePlan
        );
        log.info(
                "event=REQUEST_COMPLETED traceId={} requestId={} path=/api/users/refresh-token userId={} plan={}",
                MDC.get("traceId"),
                resolveRequestId(),
                currentUser.getId(),
                effectivePlan
        );
        return new AuthResponse(currentUser.getId(), accessToken, accessExpirationSeconds);
    }

    public void logout(String bearerToken) {
        String token = extractBearerToken(bearerToken);
        Claims claims = jwtUtil.parseClaims(token);
        long ttlSeconds = jwtUtil.remainingTtlSeconds(token);
        tokenBlacklistStore.blacklist(token, ttlSeconds);
        log.info(
                "event=REQUEST_COMPLETED traceId={} requestId={} path=/api/users/logout userId={}",
                MDC.get("traceId"),
                resolveRequestId(),
                claims.getSubject()
        );
    }

    @Transactional
    public Map<String, Object> changePassword(UserPrincipal principal, String currentPassword, String newPassword) {
        UserAccount user = userAccountRepository.findById(principal.userId())
                .orElseThrow(() -> new BadCredentialsException("User not found"));
        if (user.getPasswordHash() == null || user.getPasswordHash().isBlank()) {
            throw new BadCredentialsException("Local password is not enabled for this account");
        }
        if (currentPassword == null || !passwordEncoder.matches(currentPassword, user.getPasswordHash())) {
            throw new BadCredentialsException("Current password is invalid");
        }
        if (newPassword == null || newPassword.length() < 8) {
            throw new IllegalArgumentException("New password must be at least 8 characters");
        }
        user.setPasswordHash(passwordEncoder.encode(newPassword));
        user.setTokensValidAfter(Instant.now().minusSeconds(1));
        userAccountRepository.save(user);
        auditEventService.record(
                user.getId(),
                "ACCOUNT_PASSWORD_CHANGED",
                "USER",
                String.valueOf(user.getId()),
                "User changed account password"
        );
        return Map.of(
                "ok", true,
                "tokensRevoked", true,
                "userId", user.getId(),
                "accessToken", issueAccessToken(user),
                "expiresInSeconds", accessExpirationSeconds
        );
    }

    @Transactional
    public Map<String, Object> logoutAllDevices(UserPrincipal principal) {
        UserAccount user = userAccountRepository.findById(principal.userId())
                .orElseThrow(() -> new BadCredentialsException("User not found"));
        user.setTokensValidAfter(Instant.now().minusSeconds(1));
        userAccountRepository.save(user);
        auditEventService.record(
                user.getId(),
                "ACCOUNT_LOGOUT_ALL",
                "USER",
                String.valueOf(user.getId()),
                "User revoked all active JWT sessions"
        );
        return Map.of(
                "ok", true,
                "tokensValidAfter", user.getTokensValidAfter().toString(),
                "userId", user.getId(),
                "accessToken", issueAccessToken(user),
                "expiresInSeconds", accessExpirationSeconds
        );
    }

    private String issueAccessToken(UserAccount user) {
        String effectivePlan = userPlanService.resolveEffectivePlan(user);
        return jwtUtil.createAccessToken(
                user.getId(),
                user.getUsername(),
                user.getRole(),
                effectivePlan
        );
    }

    @Transactional(readOnly = true)
    public Map<String, Object> securityOverview(UserPrincipal principal, String bearerToken) {
        UserAccount user = userAccountRepository.findById(principal.userId())
                .orElseThrow(() -> new BadCredentialsException("User not found"));
        Claims claims = null;
        try {
            claims = jwtUtil.parseClaims(extractBearerToken(bearerToken));
        } catch (Exception ignored) {
            // Keep overview useful even when the current header is unavailable to tests/tools.
        }
        return Map.of(
                "localPasswordEnabled", user.getPasswordHash() != null && !user.getPasswordHash().isBlank(),
                "tokensValidAfter", user.getTokensValidAfter() == null ? "" : user.getTokensValidAfter().toString(),
                "currentSession", Map.of(
                        "issuedAt", claims == null || claims.getIssuedAt() == null ? "" : claims.getIssuedAt().toInstant().toString(),
                        "expiresAt", claims == null || claims.getExpiration() == null ? "" : claims.getExpiration().toInstant().toString()
                ),
                "supportsLogoutAll", true
        );
    }

    @Transactional(readOnly = true)
    public UserProfileResponse me(UserPrincipal principal) {
        UserAccount user = userAccountRepository.findById(principal.userId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));

        return new UserProfileResponse(
                user.getId(),
                user.getUsername(),
                user.getEmail(),
                readDomainModePreference(user)
        );
    }

    @Transactional
    public Map<String, Object> updateProfile(UserPrincipal principal, UserProfileUpdateRequest request) {
        UserAccount user = userAccountRepository.findById(principal.userId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        String username = normalizeUsername(request.username());
        if (!user.getUsername().equals(username) && userAccountRepository.existsByUsername(username)) {
            throw new IllegalArgumentException("Username already exists");
        }
        user.setUsername(username);
        UserAccount saved = userAccountRepository.save(user);
        auditEventService.record(
                saved.getId(),
                "ACCOUNT_PROFILE_UPDATED",
                "USER",
                String.valueOf(saved.getId()),
                "User updated profile display name"
        );
        String accessToken = issueAccessToken(saved);
        return Map.of(
                "userId", saved.getId(),
                "username", saved.getUsername(),
                "email", saved.getEmail(),
                "domainMode", readDomainModePreference(saved),
                "accessToken", accessToken,
                "expiresInSeconds", accessExpirationSeconds
        );
    }

    @Transactional
    public Map<String, Object> updatePreferences(UserPrincipal principal, UserPreferencesRequest request) {
        UserAccount user = userAccountRepository.findById(principal.userId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        Map<String, Object> preferences = readPreferencesMap(user);
        if (request.domain_mode() != null && !request.domain_mode().isBlank()) {
            preferences.put("domainMode", normalizeDomainMode(request.domain_mode()));
        }
        try {
            user.setPreferencesJson(objectMapper.writeValueAsString(preferences));
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to persist user preferences", ex);
        }
        userAccountRepository.save(user);
        return Map.of(
                "domainMode", preferences.getOrDefault("domainMode", "it")
        );
    }

    private Map<String, Object> readPreferencesMap(UserAccount user) {
        if (user.getPreferencesJson() == null || user.getPreferencesJson().isBlank()) {
            return new java.util.LinkedHashMap<>();
        }
        try {
            return objectMapper.readValue(user.getPreferencesJson(), new TypeReference<>() {});
        } catch (Exception ex) {
            return new java.util.LinkedHashMap<>();
        }
    }

    private String readDomainModePreference(UserAccount user) {
        Object value = readPreferencesMap(user).get("domainMode");
        return normalizeDomainMode(value == null ? null : String.valueOf(value));
    }

    private static String normalizeDomainMode(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase();
        if ("general".equals(normalized) || "it".equals(normalized) || "business".equals(normalized) || "education".equals(normalized)) {
            return normalized;
        }
        return "it";
    }

    private static String normalizeUsername(String value) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.length() < 3 || normalized.length() > 50) {
            throw new IllegalArgumentException("Username must be 3-50 characters");
        }
        if (!normalized.matches("[\\p{L}\\p{N} ._-]+")) {
            throw new IllegalArgumentException("Display name can only contain letters, numbers, spaces, dot, underscore, and hyphen");
        }
        return normalized;
    }

    private String extractBearerToken(String bearerToken) {
        if (bearerToken == null || !bearerToken.startsWith("Bearer ")) {
            throw new BadCredentialsException("Missing bearer token");
        }
        return bearerToken.substring(7);
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
