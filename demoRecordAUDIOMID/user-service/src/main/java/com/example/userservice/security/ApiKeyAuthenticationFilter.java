package com.example.userservice.security;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserApiKey;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserApiKeyRepository;
import com.example.userservice.service.AuditEventService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import org.slf4j.MDC;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class ApiKeyAuthenticationFilter extends OncePerRequestFilter {

    public static final String API_KEY_ID_ATTRIBUTE = "audiomind.apiKeyId";
    public static final String API_KEY_SCOPES_ATTRIBUTE = "audiomind.apiKeyScopes";

    private final UserApiKeyRepository userApiKeyRepository;
    private final UserAccountRepository userAccountRepository;
    private final AuditEventService auditEventService;

    public ApiKeyAuthenticationFilter(
            UserApiKeyRepository userApiKeyRepository,
            UserAccountRepository userAccountRepository,
            AuditEventService auditEventService
    ) {
        this.userApiKeyRepository = userApiKeyRepository;
        this.userAccountRepository = userAccountRepository;
        this.auditEventService = auditEventService;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getServletPath();
        return path.startsWith("/internal/")
                || path.startsWith("/auth/")
                || path.equals("/health")
                || path.equals("/ready")
                || path.startsWith("/actuator");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        if (SecurityContextHolder.getContext().getAuthentication() != null) {
            filterChain.doFilter(request, response);
            return;
        }

        String apiKey = resolveApiKey(request);
        if (apiKey == null || apiKey.isBlank()) {
            filterChain.doFilter(request, response);
            return;
        }

        userApiKeyRepository.findByKeyHashAndRevokedAtIsNull(sha256Hex(apiKey))
                .flatMap(key -> userAccountRepository.findById(key.getUserId()).map(user -> Map.entry(key, user)))
                .ifPresent(entry -> authenticate(request, entry.getKey(), entry.getValue()));

        try {
            filterChain.doFilter(request, response);
        } finally {
            MDC.remove("userId");
            MDC.remove("apiKeyId");
        }
    }

    private void authenticate(HttpServletRequest request, UserApiKey key, UserAccount user) {
        key.setLastUsedAt(Instant.now());
        userApiKeyRepository.save(key);

        UserPrincipal principal = new UserPrincipal(
                user.getId(),
                user.getUsername(),
                user.getRole() == null || user.getRole().isBlank() ? "USER" : user.getRole(),
                user.getPlan() == null || user.getPlan().isBlank() ? "FREE" : user.getPlan()
        );
        UsernamePasswordAuthenticationToken authentication =
                new UsernamePasswordAuthenticationToken(principal, null, List.of());
        SecurityContextHolder.getContext().setAuthentication(authentication);
        request.setAttribute(API_KEY_ID_ATTRIBUTE, key.getId());
        request.setAttribute(API_KEY_SCOPES_ATTRIBUTE, key.getScopes());
        MDC.put("userId", String.valueOf(user.getId()));
        MDC.put("apiKeyId", String.valueOf(key.getId()));
        auditEventService.record(
                user.getId(),
                "API_KEY_USED",
                "USER_API_KEY",
                String.valueOf(key.getId()),
                "API key used",
                Map.of("method", request.getMethod(), "path", request.getRequestURI())
        );
    }

    private static String resolveApiKey(HttpServletRequest request) {
        String explicit = request.getHeader("X-API-Key");
        if (explicit != null && !explicit.isBlank()) {
            return explicit.trim();
        }
        String authorization = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (authorization != null && authorization.startsWith("ApiKey ")) {
            return authorization.substring("ApiKey ".length()).trim();
        }
        return null;
    }

    private static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new IllegalStateException("Could not hash API key", ex);
        }
    }
}
