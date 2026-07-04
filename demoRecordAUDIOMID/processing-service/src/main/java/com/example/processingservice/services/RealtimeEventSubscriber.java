package com.example.processingservice.services;

import com.example.processingservice.config.RealtimeRedisProperties;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.net.InetAddress;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.stream.StreamMessageListenerContainer;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

/**
 * Manages WebSocket connections per meeting and fans out realtime events across replicas
 * via Redis Streams when enabled.
 */
@Slf4j
@Service
public class RealtimeEventSubscriber {

    private static final String TRANSCRIPT_STREAM_KEY = "stream:meeting:%d:transcript";
    private static final String KEYWORD_STREAM_KEY = "stream:meeting:%d:keywords";

    private final Map<Long, List<WebSocketSession>> meetingSessions = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;
    private final StringRedisTemplate redisTemplate;
    private final RedisConnectionFactory connectionFactory;
    private final RealtimeRedisProperties properties;
    private final String consumerName = buildConsumerName();

    private StreamMessageListenerContainer<String, MapRecord<String, String, String>> meetingEventsContainer;
    private StreamMessageListenerContainer<String, MapRecord<String, String, String>> keywordEventsContainer;

    public RealtimeEventSubscriber(
            ObjectMapper objectMapper,
            StringRedisTemplate redisTemplate,
            RedisConnectionFactory connectionFactory,
            RealtimeRedisProperties properties
    ) {
        this.objectMapper = objectMapper;
        this.redisTemplate = redisTemplate;
        this.connectionFactory = connectionFactory;
        this.properties = properties;
    }

    @PostConstruct
    void startStreamConsumers() {
        if (!properties.isRedisStreamsEnabled()) {
            log.info("Realtime Redis Streams disabled — using in-process WebSocket fan-out only");
            return;
        }
        meetingEventsContainer = createListenerContainer(
                properties.getMeetingEventsStreamKey(),
                properties.getConsumerGroup(),
                this::handleMeetingEventRecord
        );
        keywordEventsContainer = createListenerContainer(
                properties.getKeywordStreamKey(),
                properties.getConsumerGroup() + "-keywords",
                this::handleKeywordStreamRecord
        );
        log.info(
                "Realtime Redis Streams enabled consumer={} meetingStream={} keywordStream={}",
                consumerName,
                properties.getMeetingEventsStreamKey(),
                properties.getKeywordStreamKey()
        );
    }

    @PreDestroy
    void stopStreamConsumers() {
        stopContainer(meetingEventsContainer);
        stopContainer(keywordEventsContainer);
    }

    public void registerSession(Long meetingId, WebSocketSession session) {
        meetingSessions.computeIfAbsent(meetingId, k -> new CopyOnWriteArrayList<>()).add(session);
        log.info("Registered WebSocket session for meeting {}", meetingId);
        if (properties.isRedisStreamsEnabled()) {
            subscribeToTranscriptEvents(meetingId);
            subscribeToKeywordEvents(meetingId);
        }
    }

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
     * Publish to Redis Streams when enabled; otherwise broadcast locally.
     */
    public void dispatchMeetingEvent(Long meetingId, Map<String, Object> event) {
        if (!properties.isRedisStreamsEnabled()) {
            broadcastToMeeting(meetingId, event);
            return;
        }
        publishMeetingEvent(meetingId, event);
    }

    public void publishMeetingEvent(Long meetingId, Map<String, Object> event) {
        try {
            Map<String, String> fields = new HashMap<>();
            fields.put("meetingId", String.valueOf(meetingId));
            fields.put("payload", objectMapper.writeValueAsString(event));
            redisTemplate.opsForStream().add(properties.getMeetingEventsStreamKey(), fields);
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_STREAM_PUBLISH_FAILED meetingId={} reason={}",
                    meetingId,
                    ex.getMessage()
            );
            broadcastToMeeting(meetingId, event);
        }
    }

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
                    log.warn("Failed to send message to session (unregistering): {}", e.getMessage(), e);
                    try {
                        unregisterSession(meetingId, session);
                    } catch (Exception ex) {
                        log.debug("Error unregistering session after send failure: {}", ex.getMessage());
                    }
                }
            }
        } catch (Exception e) {
            log.error("Failed to serialize event for meeting {}: {}", meetingId, e.getMessage());
        }
    }

    public void subscribeToTranscriptEvents(Long meetingId) {
        String streamKey = String.format(TRANSCRIPT_STREAM_KEY, meetingId);
        log.debug("Per-meeting transcript stream reserved for future publishers: {}", streamKey);
    }

    public void subscribeToKeywordEvents(Long meetingId) {
        String streamKey = String.format(KEYWORD_STREAM_KEY, meetingId);
        log.debug("Per-meeting keyword stream reserved for future publishers: {}", streamKey);
    }

    protected void handleTranscriptEvent(Long meetingId, Map<String, String> eventData) {
        Map<String, Object> event = new HashMap<>();
        event.put("type", "transcript.partial");
        event.put("meetingId", meetingId);
        event.putAll(convertFromRedisFormat(eventData));
        broadcastToMeeting(meetingId, event);
    }

    protected void handleKeywordEvent(Long meetingId, Map<String, String> eventData) {
        Map<String, Object> event = new HashMap<>();
        event.put("type", "keyword.hit");
        event.put("meetingId", meetingId);
        event.putAll(convertFromRedisFormat(eventData));
        broadcastToMeeting(meetingId, event);
    }

    public int getActiveConnectionCount(Long meetingId) {
        List<WebSocketSession> sessions = meetingSessions.get(meetingId);
        return sessions != null ? sessions.size() : 0;
    }

    public int getTotalActiveConnections() {
        return meetingSessions.values().stream().mapToInt(List::size).sum();
    }

    private StreamMessageListenerContainer<String, MapRecord<String, String, String>> createListenerContainer(
            String streamKey,
            String consumerGroup,
            java.util.function.Consumer<MapRecord<String, String, String>> handler
    ) {
        ensureConsumerGroup(streamKey, consumerGroup);
        StreamMessageListenerContainer.StreamMessageListenerContainerOptions<String, MapRecord<String, String, String>> options =
                StreamMessageListenerContainer.StreamMessageListenerContainerOptions
                        .builder()
                        .pollTimeout(Duration.ofSeconds(2))
                        .build();
        StreamMessageListenerContainer<String, MapRecord<String, String, String>> container =
                StreamMessageListenerContainer.create(connectionFactory, options);
        container.receive(
                Consumer.from(consumerGroup, consumerName),
                StreamOffset.create(streamKey, ReadOffset.lastConsumed()),
                handler::accept
        );
        container.start();
        return container;
    }

    private void ensureConsumerGroup(String streamKey, String consumerGroup) {
        try {
            redisTemplate.opsForStream().createGroup(streamKey, consumerGroup);
        } catch (Exception ex) {
            log.debug("Consumer group {} on {} already exists or stream pending: {}", consumerGroup, streamKey, ex.getMessage());
        }
    }

    private void handleMeetingEventRecord(MapRecord<String, String, String> message) {
        try {
            Map<String, String> value = message.getValue();
            Long meetingId = Long.parseLong(value.get("meetingId"));
            Map<String, Object> event = objectMapper.readValue(
                    value.get("payload"),
                    new TypeReference<Map<String, Object>>() {}
            );
            broadcastToMeeting(meetingId, event);
        } catch (Exception ex) {
            log.warn("event=REALTIME_STREAM_CONSUME_FAILED stream=meeting reason={}", ex.getMessage());
        }
    }

    private void handleKeywordStreamRecord(MapRecord<String, String, String> message) {
        try {
            Map<String, String> value = message.getValue();
            Long meetingId = Long.parseLong(value.get("meeting_id"));
            handleKeywordEvent(meetingId, value);
        } catch (Exception ex) {
            log.warn("event=REALTIME_STREAM_CONSUME_FAILED stream=keyword reason={}", ex.getMessage());
        }
    }

    private void stopContainer(StreamMessageListenerContainer<String, MapRecord<String, String, String>> container) {
        if (container != null) {
            try {
                container.stop();
            } catch (Exception ex) {
                log.debug("Failed to stop stream listener container: {}", ex.getMessage());
            }
        }
    }

    private Map<String, Object> convertFromRedisFormat(Map<String, String> redisData) {
        Map<String, Object> converted = new HashMap<>();
        for (Map.Entry<String, String> entry : redisData.entrySet()) {
            String value = entry.getValue();
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

    private static String buildConsumerName() {
        try {
            String host = InetAddress.getLocalHost().getHostName();
            return host + "-" + UUID.randomUUID();
        } catch (Exception ex) {
            return "processing-" + UUID.randomUUID();
        }
    }
}
