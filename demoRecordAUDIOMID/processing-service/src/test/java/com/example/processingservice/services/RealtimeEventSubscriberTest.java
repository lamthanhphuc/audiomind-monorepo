package com.example.processingservice.services;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.processingservice.config.RealtimeRedisProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

class RealtimeEventSubscriberTest {

    private RealtimeEventSubscriber subscriber;
    private WebSocketSession session;

    @BeforeEach
    void setUp() {
        RealtimeRedisProperties properties = new RealtimeRedisProperties();
        properties.setRedisStreamsEnabled(false);
        subscriber = new RealtimeEventSubscriber(
                new ObjectMapper(),
                mock(StringRedisTemplate.class),
                mock(RedisConnectionFactory.class),
                properties
        );
        session = mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
    }

    @Test
    void dispatchMeetingEvent_broadcastsLocallyWhenRedisStreamsDisabled() throws Exception {
        subscriber.registerSession(42L, session);

        subscriber.dispatchMeetingEvent(42L, Map.of("type", "transcript.partial", "text", "hello"));

        verify(session).sendMessage(any(TextMessage.class));
    }

    @Test
    void dispatchMeetingEvent_doesNotPublishToRedisWhenDisabled() {
        StringRedisTemplate redisTemplate = mock(StringRedisTemplate.class);
        RealtimeRedisProperties properties = new RealtimeRedisProperties();
        properties.setRedisStreamsEnabled(false);
        RealtimeEventSubscriber localOnly = new RealtimeEventSubscriber(
                new ObjectMapper(),
                redisTemplate,
                mock(RedisConnectionFactory.class),
                properties
        );

        localOnly.dispatchMeetingEvent(7L, Map.of("type", "stream.status"));

        verify(redisTemplate, never()).opsForStream();
    }
}
