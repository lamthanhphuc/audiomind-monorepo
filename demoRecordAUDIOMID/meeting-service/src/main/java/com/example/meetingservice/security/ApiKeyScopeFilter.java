package com.example.meetingservice.security;

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
        Object scopesRaw = request.getAttribute(ApiKeyAuthenticationFilter.API_KEY_SCOPES_ATTRIBUTE);
        if (scopesRaw == null) {
            filterChain.doFilter(request, response);
            return;
        }
        Set<String> scopes = Arrays.stream(String.valueOf(scopesRaw).split(","))
                .map(scope -> scope.trim().toLowerCase(Locale.ROOT))
                .filter(scope -> !scope.isBlank())
                .collect(Collectors.toSet());
        boolean write = !("GET".equalsIgnoreCase(request.getMethod())
                || "HEAD".equalsIgnoreCase(request.getMethod())
                || "OPTIONS".equalsIgnoreCase(request.getMethod()));
        boolean allowed = scopes.contains("admin") || (!write && (scopes.contains("read") || scopes.contains("write"))) || (write && scopes.contains("write"));
        if (!allowed) {
            response.sendError(HttpStatus.FORBIDDEN.value(), "API key scope is not allowed for this operation");
            return;
        }
        filterChain.doFilter(request, response);
    }
}
