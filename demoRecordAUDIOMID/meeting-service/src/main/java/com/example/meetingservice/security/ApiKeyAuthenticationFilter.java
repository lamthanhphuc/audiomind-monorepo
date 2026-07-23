package com.example.meetingservice.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
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

    public static final String API_KEY_SCOPES_ATTRIBUTE = "audiomind.apiKeyScopes";

    private final ApiKeyIntrospectionClient introspectionClient;

    public ApiKeyAuthenticationFilter(ApiKeyIntrospectionClient introspectionClient) {
        this.introspectionClient = introspectionClient;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getServletPath();
        return path.startsWith("/internal/") || path.equals("/health") || path.equals("/ready") || path.startsWith("/actuator");
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
        try {
            Map<String, Object> payload = introspectionClient.introspect(apiKey, request.getMethod(), request.getRequestURI());
            if (Boolean.TRUE.equals(payload.get("active"))) {
                Long userId = Long.valueOf(String.valueOf(payload.get("userId")));
                UserPrincipal principal = new UserPrincipal(
                        userId,
                        String.valueOf(payload.getOrDefault("username", "api-key")),
                        String.valueOf(payload.getOrDefault("role", "USER")),
                        String.valueOf(payload.getOrDefault("plan", "FREE"))
                );
                SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(principal, null, List.of()));
                request.setAttribute(API_KEY_SCOPES_ATTRIBUTE, String.valueOf(payload.getOrDefault("scopes", "read")));
                MDC.put("userId", String.valueOf(userId));
            }
        } catch (RuntimeException ex) {
            SecurityContextHolder.clearContext();
        }
        try {
            filterChain.doFilter(request, response);
        } finally {
            MDC.remove("userId");
        }
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
}
