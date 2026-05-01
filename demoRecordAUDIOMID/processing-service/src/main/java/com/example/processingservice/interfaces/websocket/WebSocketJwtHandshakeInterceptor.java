package com.example.processingservice.interfaces.websocket;

import com.example.processingservice.security.JwtUtil;
import io.jsonwebtoken.Claims;
import java.util.List;
import java.util.Map;
import java.net.URI;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Component
public class WebSocketJwtHandshakeInterceptor implements HandshakeInterceptor {

    private final JwtUtil jwtUtil;

    public WebSocketJwtHandshakeInterceptor(JwtUtil jwtUtil) {
        this.jwtUtil = jwtUtil;
    }

    @Override
    public boolean beforeHandshake(
            ServerHttpRequest request,
            ServerHttpResponse response,
            WebSocketHandler wsHandler,
            Map<String, Object> attributes
    ) {
        List<String> authHeaders = request.getHeaders().get(HttpHeaders.AUTHORIZATION);
        String authHeader = null;

        if (authHeaders != null && !authHeaders.isEmpty()) {
            authHeader = authHeaders.getFirst();
        }

        // Allow token passed as query parameter `token` for dev clients that cannot set headers.
        if ((authHeader == null || authHeader.isBlank()) && request.getURI() != null) {
            String rawQuery = request.getURI().getQuery();
            if (rawQuery != null && !rawQuery.isBlank()) {
                String[] pairs = rawQuery.split("&");
                for (String pair : pairs) {
                    String[] kv = pair.split("=", 2);
                    if (kv.length == 2 && (kv[0].equalsIgnoreCase("token") || kv[0].equalsIgnoreCase("authorization"))) {
                        String decoded = java.net.URLDecoder.decode(kv[1], java.nio.charset.StandardCharsets.UTF_8);
                        authHeader = decoded.startsWith("Bearer ") ? decoded : ("Bearer " + decoded);
                        break;
                    }
                }
            }
        }

        if (authHeader == null || authHeader.isBlank()) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }

        if (!authHeader.startsWith("Bearer ")) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }

        try {
            Claims claims = jwtUtil.parseClaims(authHeader.substring(7));

            Long userId = Long.parseLong(claims.getSubject());
            String username = claims.get("username", String.class);
            Long meetingId = extractMeetingId(request.getURI());
            if (meetingId == null) {
                response.setStatusCode(HttpStatus.BAD_REQUEST);
                return false;
            }

            attributes.put("userId", userId);
            attributes.put("username", username);
            attributes.put("meetingId", meetingId);
            attributes.put("authorization", authHeader);
            return true;
        } catch (Exception ex) {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }
    }

    @Override
    public void afterHandshake(
            ServerHttpRequest request,
            ServerHttpResponse response,
            WebSocketHandler wsHandler,
            Exception exception
    ) {
        // No-op.
    }

    private Long extractMeetingId(URI uri) {
        if (uri == null) {
            return null;
        }

        String path = uri.getPath();
        if (path == null || path.isBlank()) {
            return null;
        }

        String[] segments = path.split("/");
        if (segments.length == 0) {
            return null;
        }

        String candidate = segments[segments.length - 1];
        try {
            return Long.parseLong(candidate);
        } catch (NumberFormatException ignored) {
            return null;
        }
    }
}
