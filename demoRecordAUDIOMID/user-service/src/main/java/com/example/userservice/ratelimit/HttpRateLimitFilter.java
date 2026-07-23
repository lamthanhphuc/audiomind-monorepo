package com.example.userservice.ratelimit;

import com.example.userservice.controller.ApiErrorResponse;
import com.example.userservice.controller.ErrorCode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 20)
@RequiredArgsConstructor
public class HttpRateLimitFilter extends OncePerRequestFilter {

    private final HttpRateLimitProperties properties;
    private final HttpRateLimitService rateLimitService;
    private final ObjectMapper objectMapper;

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain
    ) throws ServletException, IOException {
        if (!properties.isEnabled()) {
            filterChain.doFilter(request, response);
            return;
        }

        Optional<RateLimitRule> rule = resolveRule(request);
        if (rule.isEmpty()) {
            filterChain.doFilter(request, response);
            return;
        }

        RateLimitRule resolved = rule.get();
        String bucket = resolved.bucketKey(request);
        if (!rateLimitService.tryConsume(bucket, resolved.limit(), Duration.ofMinutes(1))) {
            writeRateLimited(response, request);
            return;
        }

        filterChain.doFilter(request, response);
    }

    private Optional<RateLimitRule> resolveRule(HttpServletRequest request) {
        String method = request.getMethod();
        String path = request.getRequestURI();
        if ("POST".equalsIgnoreCase(method) && path.endsWith("/api/users/login")) {
            return Optional.of(new RateLimitRule("login", properties.getLoginPerMinute(), HttpRateLimitFilter::clientIp));
        }
        if ("POST".equalsIgnoreCase(method) && path.endsWith("/api/users/register")) {
            return Optional.of(new RateLimitRule("register", properties.getRegisterPerMinute(), HttpRateLimitFilter::clientIp));
        }
        if ("POST".equalsIgnoreCase(method) && path.endsWith("/api/billing/checkout/pro")) {
            return Optional.of(new RateLimitRule(
                    "checkout",
                    properties.getCheckoutPerMinute(),
                    HttpRateLimitFilter::authSubjectOrIp
            ));
        }
        if (path.startsWith("/auth/google")) {
            return Optional.of(new RateLimitRule(
                    "google-oauth",
                    properties.getGoogleOAuthPerMinute(),
                    HttpRateLimitFilter::clientIp
            ));
        }
        if (resolveApiKey(request).isPresent()) {
            return Optional.of(new RateLimitRule(
                    "api-key",
                    properties.getApiKeyPerMinute(),
                    requestWithKey -> "key:" + sha256Hex(resolveApiKey(requestWithKey).orElse(""))
            ));
        }
        return Optional.empty();
    }

    private void writeRateLimited(HttpServletResponse response, HttpServletRequest request) throws IOException {
        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader("Retry-After", "60");
        ApiErrorResponse body = new ApiErrorResponse(
                ErrorCode.RATE_LIMITED.name(),
                ErrorCode.RATE_LIMITED.defaultMessage(),
                HttpStatus.TOO_MANY_REQUESTS.value(),
                Instant.now().toString(),
                null,
                request.getRequestURI(),
                Map.of("retryAfterSeconds", 60)
        );
        response.getWriter().write(objectMapper.writeValueAsString(body));
    }

    private static String clientIp(HttpServletRequest request) {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    private static String authSubjectOrIp(HttpServletRequest request) {
        if (request.getUserPrincipal() != null) {
            return "user:" + request.getUserPrincipal().getName();
        }
        return "ip:" + clientIp(request);
    }

    private static Optional<String> resolveApiKey(HttpServletRequest request) {
        String explicit = request.getHeader("X-API-Key");
        if (explicit != null && !explicit.isBlank()) {
            return Optional.of(explicit.trim());
        }
        String authorization = request.getHeader("Authorization");
        if (authorization != null && authorization.startsWith("ApiKey ")) {
            return Optional.of(authorization.substring("ApiKey ".length()).trim());
        }
        return Optional.empty();
    }

    private static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            return "hash-error";
        }
    }

    private record RateLimitRule(String name, int limit, java.util.function.Function<HttpServletRequest, String> keyFn) {
        String bucketKey(HttpServletRequest request) {
            return name + ":" + keyFn.apply(request);
        }
    }
}
