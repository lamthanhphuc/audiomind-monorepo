package com.example.processingservice.services;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.example.processingservice.config.RealtimeRedisProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * Verifies Redis Streams fan-out between two processing-api replicas:
 * publisher replica XADDs; consumer replica receives and broadcasts to local WebSocket sessions.
 */
@Testcontainers(disabledWithoutDocker = true)
class RealtimeEventSubscriberRedisIT {

    private static final String STREAM_KEY = "stream:realtime:meeting-events-it";
    private static final String CONSUMER_GROUP = "processing-realtime-it";

    @Container
    @SuppressWarnings("resource")
    static GenericContainer<?> redis = new GenericContainer<>(DockerImageName.parse("redis:7-alpine"))
            .withExposedPorts(6379);

    private LettuceConnectionFactory publisherFactory;
    private LettuceConnectionFactory consumerFactory;
    private RealtimeEventSubscriber publisher;
    private RealtimeEventSubscriber consumer;

    @BeforeEach
    void setUp() {
        publisherFactory = createConnectionFactory();
        consumerFactory = createConnectionFactory();

        publisher = createSubscriber(publisherFactory, true, false);
        consumer = createSubscriber(consumerFactory, true, true);
    }

    @AfterEach
    void tearDown() {
        if (consumer != null) {
            consumer.stopStreamConsumers();
        }
        if (publisherFactory != null) {
            publisherFactory.destroy();
        }
        if (consumerFactory != null) {
            consumerFactory.destroy();
        }
    }

    @Test
    void publisherReplicaFansOutToConsumerReplicaWebSocket() throws Exception {
        WebSocketSession session = mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
        AtomicReference<String> capturedPayload = new AtomicReference<>();
        doAnswer(invocation -> {
            TextMessage message = invocation.getArgument(0);
            capturedPayload.set(message.getPayload());
            return null;
        }).when(session).sendMessage(any(TextMessage.class));

        consumer.registerSession(99L, session);

        publisher.dispatchMeetingEvent(
                99L,
                Map.of("type", "transcript.partial", "text", "cross-replica-event")
        );

        String payload = awaitPayload(capturedPayload, 10_000);
        assertNotNull(payload);
        assertTrue(payload.contains("cross-replica-event"));
        assertTrue(payload.contains("transcript.partial"));
    }

    private static String awaitPayload(AtomicReference<String> capturedPayload, long timeoutMs)
            throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            String value = capturedPayload.get();
            if (value != null) {
                return value;
            }
            Thread.sleep(100L);
        }
        return capturedPayload.get();
    }

    private LettuceConnectionFactory createConnectionFactory() {
        LettuceConnectionFactory factory = new LettuceConnectionFactory(
                redis.getHost(),
                redis.getMappedPort(6379)
        );
        factory.afterPropertiesSet();
        return factory;
    }

    private RealtimeEventSubscriber createSubscriber(
            LettuceConnectionFactory factory,
            boolean streamsEnabled,
            boolean startConsumers
    ) {
        RealtimeRedisProperties properties = new RealtimeRedisProperties();
        properties.setRedisStreamsEnabled(streamsEnabled);
        properties.setMeetingEventsStreamKey(STREAM_KEY);
        properties.setKeywordStreamKey("realtime.keyword_hits-it-" + UUID.randomUUID());
        properties.setConsumerGroup(CONSUMER_GROUP);

        StringRedisTemplate redisTemplate = new StringRedisTemplate(factory);
        redisTemplate.afterPropertiesSet();

        RealtimeEventSubscriber subscriber = new RealtimeEventSubscriber(
                new ObjectMapper(),
                redisTemplate,
                factory,
                properties
        );
        if (startConsumers) {
            subscriber.startStreamConsumers();
        }
        return subscriber;
    }
}
