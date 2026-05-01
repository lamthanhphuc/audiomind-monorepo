package com.example.processingservice.interfaces.websocket;

import com.example.processingservice.security.MeetingChannelAuthorizer;
import com.example.processingservice.services.RealtimeEventSubscriber;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Slf4j
@Component
public class MeetingWebSocketHandler extends TextWebSocketHandler {

    private final MeetingChannelAuthorizer meetingChannelAuthorizer;
    private final RealtimeEventSubscriber realtimeEventSubscriber;
    private final ObjectMapper objectMapper;

    public MeetingWebSocketHandler(
            MeetingChannelAuthorizer meetingChannelAuthorizer,
            RealtimeEventSubscriber realtimeEventSubscriber,
            ObjectMapper objectMapper) {
        this.meetingChannelAuthorizer = meetingChannelAuthorizer;
        this.realtimeEventSubscriber = realtimeEventSubscriber;
        this.objectMapper = objectMapper;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        Long userId = getLongAttribute(session, "userId");
        Long meetingId = getLongAttribute(session, "meetingId");
        
        if (userId == null || meetingId == null) {
            session.close(CloseStatus.NOT_ACCEPTABLE.withReason("Missing userId or meetingId"));
            return;
        }
        
        String authorization = getStringAttribute(session, "authorization");
        if (!meetingChannelAuthorizer.canJoin(userId, meetingId, authorization)) {
            session.close(CloseStatus.POLICY_VIOLATION.withReason("Forbidden"));
            return;
        }

        // Register session with realtime subscriber
        realtimeEventSubscriber.registerSession(meetingId, session);

        // Send session.ready event to client
        Map<String, Object> readyEvent = Map.of(
                "type", "session.ready",
                "meetingId", meetingId,
                "userId", userId,
                "activeConnections", realtimeEventSubscriber.getActiveConnectionCount(meetingId)
        );
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(readyEvent)));

        Map<String, Object> transcriptEvent = Map.of(
                "type", "transcript.partial",
                "meetingId", meetingId,
                "segmentId", java.util.UUID.randomUUID().toString(),
                "speaker", "SPEAKER_1",
                "startTime", 0.0,
                "endTime", 5.0,
                "text", "[processing started]",
                "language", "vi",
                "versionHash", ""
        );
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(transcriptEvent)));

        Map<String, Object> keywordEvent = Map.of(
                "type", "keyword.hit",
                "meetingId", meetingId,
                "keywordId", "realtime-start",
                "term", "realtime",
                "confidence", 0.99,
                "ranges", java.util.List.of(0, 8),
                "domain", "realtime",
                "versionHash", ""
        );
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(keywordEvent)));

        log.info("WebSocket session established for userId={}, meetingId={}", userId, meetingId);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        String payload = message.getPayload();
        if (payload == null || payload.isBlank()) {
            return;
        }

        Long meetingId = getLongAttribute(session, "meetingId");
        if (meetingId == null) {
            session.close(new CloseStatus(1008, "Invalid session state"));
            return;
        }

        // Handle client messages like auth.init, stream.pause, stream.resume, stream.stop
        Map<String, Object> statusEvent = Map.of(
                "type", "stream.status",
                "state", "received",
                "activeConnections", realtimeEventSubscriber.getActiveConnectionCount(meetingId)
        );
        
        session.sendMessage(new TextMessage(objectMapper.writeValueAsString(statusEvent)));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        Long meetingId = getLongAttribute(session, "meetingId");
        if (meetingId != null) {
            realtimeEventSubscriber.unregisterSession(meetingId, session);
            log.info("WebSocket session closed for meetingId={}", meetingId);
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
        Long meetingId = getLongAttribute(session, "meetingId");
        if (meetingId != null) {
            realtimeEventSubscriber.unregisterSession(meetingId, session);
            log.warn("WebSocket transport error for meetingId={}: {}", meetingId, exception.getMessage());
        }
    }

    private Long getLongAttribute(WebSocketSession session, String key) {
        Object value = session.getAttributes().get(key);
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value != null) {
            try {
                return Long.parseLong(String.valueOf(value));
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private String getStringAttribute(WebSocketSession session, String key) {
        Object value = session.getAttributes().get(key);
        return value == null ? null : String.valueOf(value);
    }
}
