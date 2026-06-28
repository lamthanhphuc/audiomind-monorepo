package com.example.processingservice.ratelimit;

import com.example.processingservice.controller.ApiErrorResponse;
import com.example.processingservice.controller.ErrorCode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;
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

    private static final Pattern TRANSCRIPT_SEARCH_PATH = Pattern.compile("^/processing/\\d+/transcript/search$");

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
        if (!rateLimitService.tryConsume(resolved.bucketKey(request), resolved.limit(), Duration.ofMinutes(1))) {
            writeRateLimited(response, request);
            return;
        }

        filterChain.doFilter(request, response);
    }

    private Optional<RateLimitRule> resolveRule(HttpServletRequest request) {
        String method = request.getMethod();
        String path = request.getRequestURI();
        if ("POST".equalsIgnoreCase(method) && "/processing/upload".equals(path)) {
            return Optional.of(new RateLimitRule("upload", properties.getUploadPerMinute(), HttpRateLimitFilter::authSubjectOrIp));
        }
        if ("GET".equalsIgnoreCase(method) && TRANSCRIPT_SEARCH_PATH.matcher(path).matches()) {
            return Optional.of(new RateLimitRule("transcript-search", properties.getTranscriptSearchPerMinute(), HttpRateLimitFilter::authSubjectOrIp));
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
        if (request.getUserPrincipal() != null && request.getUserPrincipal().getName() != null) {
            return "user:" + request.getUserPrincipal().getName();
        }
        return "ip:" + clientIp(request);
    }

    private record RateLimitRule(String name, int limit, java.util.function.Function<HttpServletRequest, String> keyFn) {
        String bucketKey(HttpServletRequest request) {
            return name + ":" + keyFn.apply(request);
        }
    }
}
