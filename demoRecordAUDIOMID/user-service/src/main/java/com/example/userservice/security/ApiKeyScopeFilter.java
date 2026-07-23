package com.example.userservice.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class ApiKeyScopeFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        Object apiKeyId = request.getAttribute(ApiKeyAuthenticationFilter.API_KEY_ID_ATTRIBUTE);
        if (apiKeyId == null) {
            filterChain.doFilter(request, response);
            return;
        }

        Set<String> scopes = parseScopes((String) request.getAttribute(ApiKeyAuthenticationFilter.API_KEY_SCOPES_ATTRIBUTE));
        String required = requiredScope(request);
        if (!hasScope(scopes, required)) {
            response.sendError(HttpStatus.FORBIDDEN.value(), "API key scope is not allowed for this operation");
            return;
        }

        filterChain.doFilter(request, response);
    }

    private static String requiredScope(HttpServletRequest request) {
        String path = request.getRequestURI();
        if (path.startsWith("/api/admin/")) {
            return "admin";
        }
        String method = request.getMethod();
        if ("GET".equalsIgnoreCase(method) || "HEAD".equalsIgnoreCase(method) || "OPTIONS".equalsIgnoreCase(method)) {
            return "read";
        }
        return "write";
    }

    private static boolean hasScope(Set<String> scopes, String required) {
        if (scopes.contains("admin")) {
            return true;
        }
        if ("read".equals(required)) {
            return scopes.contains("read") || scopes.contains("write");
        }
        return scopes.contains(required);
    }

    private static Set<String> parseScopes(String raw) {
        if (raw == null || raw.isBlank()) {
            return Set.of("read");
        }
        return Arrays.stream(raw.split(","))
                .map(scope -> scope.trim().toLowerCase(Locale.ROOT))
                .filter(scope -> !scope.isBlank())
                .collect(Collectors.toSet());
    }
}
