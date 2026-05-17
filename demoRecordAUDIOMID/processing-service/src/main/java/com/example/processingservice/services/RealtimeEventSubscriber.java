package com.example.processingservice.services;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.redis.connection.stream.ObjectRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.stream.StreamListener;
import org.springframework.data.redis.stream.StreamMessageListenerContainer;
import org.springframework.data.redis.stream.StreamMessageListenerContainer.StreamMessageListenerContainerOptions;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Manages WebSocket connections per meeting and subscribes to Redis Streams
 * for real-time event delivery (transcript, keywords).
 */
@Slf4j
@Service
public class RealtimeEventSubscriber {

    private static final String TRANSCRIPT_STREAM_KEY = "stream:meeting:%d:transcript";
    private static final String KEYWORD_STREAM_KEY = "stream:meeting:%d:keywords";

    // WebSocket session management
    private final Map<Long, List<WebSocketSession>> meetingSessions = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;
    private StreamMessageListenerContainer<String, ObjectRecord<String, Map<String, String>>> container;

    public RealtimeEventSubscriber(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /**
     * Register a WebSocket session for a specific meeting.
     *
     * @param meetingId The meeting ID.
     * @param session   The WebSocket session.
     */
    public void registerSession(Long meetingId, WebSocketSession session) {
        meetingSessions.computeIfAbsent(meetingId, k -> new CopyOnWriteArrayList<>()).add(session);
        log.info("Registered WebSocket session for meeting {}", meetingId);
    }

    /**
     * Unregister a WebSocket session for a specific meeting.
     *
     * @param meetingId The meeting ID.
     * @param session   The WebSocket session.
     */
    public void unregisterSession(Long meetingId, WebSocketSession session) {
        List<WebSocketSession> sessions = meetingSessions.get(meetingId);
        if (sessions != null) {
            sessions.remove(session);
            if (sessions.isEmpty()) {
                meetingSessions.remove(meetingId);
                log.info("Removed all WebSocket sessions for meeting {}", meetingId);
            }
        }
    }

    /**
     * Broadcast an event to all WebSocket clients connected to a meeting.
     *
     * @param meetingId The meeting ID.
     * @param event    The event data to broadcast.
     */
    public void broadcastToMeeting(Long meetingId, Map<String, Object> event) {
        List<WebSocketSession> sessions = meetingSessions.get(meetingId);
        if (sessions == null || sessions.isEmpty()) {
            return;
        }

        try {
            String payload = objectMapper.writeValueAsString(event);
            TextMessage message = new TextMessage(payload);

            for (WebSocketSession session : new ArrayList<>(sessions)) {
                try {
                    if (session.isOpen()) {
                        session.sendMessage(message);
                    } else {
                        unregisterSession(meetingId, session);
                    }
                } catch (Exception e) {
                    // Protect the broadcast loop from any unexpected runtime exception
                    log.warn("Failed to send message to session (unregistering): {}", e.getMessage(), e);
                    try {
                        unregisterSession(meetingId, session);
                    } catch (Exception ex) {
                        log.debug("Error unregistering session after send failure: {}", ex.getMessage());
                    }
                }
            }
        } catch (JsonProcessingException e) {
            log.error("Failed to serialize event for meeting {}: {}", meetingId, e.getMessage());
        }
    }

    /**
     * Listen for transcript events from Redis Streams and broadcast to WebSocket clients.
     * (Placeholder for integration with actual stream listener)
     */
    public void subscribeToTranscriptEvents(Long meetingId) {
        String streamKey = String.format(TRANSCRIPT_STREAM_KEY, meetingId);
        log.debug("Subscribing to transcript events for stream: {}", streamKey);
        // Will be integrated with StreamMessageListenerContainer in full implementation
    }

    /**
     * Listen for keyword events from Redis Streams and broadcast to WebSocket clients.
     * (Placeholder for integration with actual stream listener)
     */
    public void subscribeToKeywordEvents(Long meetingId) {
        String streamKey = String.format(KEYWORD_STREAM_KEY, meetingId);
        log.debug("Subscribing to keyword events for stream: {}", streamKey);
        // Will be integrated with StreamMessageListenerContainer in full implementation
    }

    /**
     * Sample method to handle incoming events from Redis Streams.
     * This would be called by the StreamListener when new messages arrive.
     *
     * @param meetingId The meeting ID associated with the stream.
     * @param eventData The event data from Redis Stream.
     */
    protected void handleTranscriptEvent(Long meetingId, Map<String, String> eventData) {
        Map<String, Object> event = new HashMap<>();
        event.put("type", "transcript.partial");
        event.put("meetingId", meetingId);
        event.putAll(convertFromRedisFormat(eventData));

        broadcastToMeeting(meetingId, event);
    }

    /**
     * Sample method to handle keyword events from Redis Streams.
     *
     * @param meetingId The meeting ID associated with the stream.
     * @param eventData The event data from Redis Stream.
     */
    protected void handleKeywordEvent(Long meetingId, Map<String, String> eventData) {
        Map<String, Object> event = new HashMap<>();
        event.put("type", "keyword.hit");
        event.put("meetingId", meetingId);
        event.putAll(convertFromRedisFormat(eventData));

        broadcastToMeeting(meetingId, event);
    }

    /**
     * Convert Redis Stream data format to application event format.
     *
     * @param redisData The data from Redis Stream.
     * @return Converted map with typed values.
     */
    private Map<String, Object> convertFromRedisFormat(Map<String, String> redisData) {
        Map<String, Object> converted = new HashMap<>();
        for (Map.Entry<String, String> entry : redisData.entrySet()) {
            String value = entry.getValue();
            // Try to parse as number if possible
            if (value != null && !value.isEmpty()) {
                try {
                    if (value.contains(".")) {
                        converted.put(entry.getKey(), Double.parseDouble(value));
                    } else {
                        converted.put(entry.getKey(), Long.parseLong(value));
                    }
                } catch (NumberFormatException e) {
                    converted.put(entry.getKey(), value);
                }
            } else {
                converted.put(entry.getKey(), value);
            }
        }
        return converted;
    }

    /**
     * Get the number of active WebSocket connections for a meeting.
     *
     * @param meetingId The meeting ID.
     * @return The number of active connections.
     */
    public int getActiveConnectionCount(Long meetingId) {
        List<WebSocketSession> sessions = meetingSessions.get(meetingId);
        return sessions != null ? sessions.size() : 0;
    }

    /**
     * Get total active WebSocket connections across all meetings.
     *
     * @return The total number of active connections.
     */
    public int getTotalActiveConnections() {
        return meetingSessions.values().stream().mapToInt(List::size).sum();
    }
}
