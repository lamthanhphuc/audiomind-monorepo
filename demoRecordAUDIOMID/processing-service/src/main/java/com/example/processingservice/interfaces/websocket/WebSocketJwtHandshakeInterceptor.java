package com.example.processingservice.interfaces.websocket;

import com.example.processingservice.config.TraceIdFilter;
import java.util.Map;
import java.net.URI;
import java.util.UUID;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Slf4j
@Component
public class WebSocketJwtHandshakeInterceptor implements HandshakeInterceptor {

    @Override
    public boolean beforeHandshake(
            ServerHttpRequest request,
            ServerHttpResponse response,
            WebSocketHandler wsHandler,
            Map<String, Object> attributes
    ) {
        log.info("WebSocket handshake attempt - URI: {}, Query: {}", request.getURI(), request.getURI().getQuery());

        Long meetingId = extractMeetingId(request.getURI());
        if (meetingId == null) {
            log.warn("Failed to extract meetingId from path: {}", request.getURI().getPath());
            response.setStatusCode(HttpStatus.BAD_REQUEST);
            return false;
        }
        attributes.put("meetingId", meetingId);
        String traceId = request.getHeaders().getFirst(TraceIdFilter.TRACE_HEADER);
        if (traceId == null || traceId.isBlank()) {
            traceId = request.getHeaders().getFirst("x-trace-id");
        }
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString();
        }
        attributes.put(TraceIdFilter.TRACE_ID_ATTR, traceId);

        log.info(
                "WebSocket handshake proceeding meetingId={} traceId={}; auth.init will authenticate the session",
                meetingId,
                traceId
        );
        return true;
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
