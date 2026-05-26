package com.example.userservice.security;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.slf4j.MDC;
import org.springframework.http.HttpHeaders;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private final JwtUtil jwtUtil;
    private final TokenBlacklistStore tokenBlacklistStore;

    public JwtAuthenticationFilter(JwtUtil jwtUtil, TokenBlacklistStore tokenBlacklistStore) {
        this.jwtUtil = jwtUtil;
        this.tokenBlacklistStore = tokenBlacklistStore;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = resolvePath(request);
        return path.equals("/api/users/register")
                || path.equals("/api/users/login")
                || path.equals("/health")
                || path.equals("/ready")
                || path.startsWith("/actuator");
    }

    private String resolvePath(HttpServletRequest request) {
        String servletPath = request.getServletPath();
        if (servletPath != null && !servletPath.isBlank()) {
            return servletPath;
        }

        String requestUri = request.getRequestURI();
        if (requestUri == null || requestUri.isBlank()) {
            return "";
        }

        String contextPath = request.getContextPath();
        if (contextPath != null && !contextPath.isBlank() && requestUri.startsWith(contextPath)) {
            return requestUri.substring(contextPath.length());
        }

        return requestUri;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        String authHeader = request.getHeader(HttpHeaders.AUTHORIZATION);
        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            filterChain.doFilter(request, response);
            return;
        }

        String token = authHeader.substring(7);
        if (tokenBlacklistStore.isBlacklisted(token)) {
            SecurityContextHolder.clearContext();
            filterChain.doFilter(request, response);
            return;
        }

        try {
            Claims claims = jwtUtil.parseClaims(token);
            Long userId = Long.parseLong(claims.getSubject());
            String username = claims.get("username", String.class);

            UserPrincipal principal = new UserPrincipal(userId, username);
            UsernamePasswordAuthenticationToken authentication =
                    new UsernamePasswordAuthenticationToken(principal, null, List.of());

            SecurityContextHolder.getContext().setAuthentication(authentication);
            MDC.put("userId", String.valueOf(userId));
        } catch (JwtException | IllegalArgumentException ex) {
            SecurityContextHolder.clearContext();
        }

        try {
            filterChain.doFilter(request, response);
        } finally {
            MDC.remove("userId");
        }
    }
}
