package com.example.userservice.service;

import com.example.userservice.client.PendingMeetingShareClient;
import com.example.userservice.controller.dto.AuthResponse;
import com.example.userservice.controller.dto.LoginRequest;
import com.example.userservice.controller.dto.RegisterRequest;
import com.example.userservice.controller.dto.RegisterResponse;
import com.example.userservice.controller.dto.UserPreferencesRequest;
import com.example.userservice.controller.dto.UserProfileResponse;
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
