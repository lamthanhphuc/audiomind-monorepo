package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.processingservice.client.AIServiceClient;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

class HealthControllerTest {

    @Test
    void health_shouldReturnUpPayload() {
        StringRedisTemplate redisTemplate = mock(StringRedisTemplate.class);
        AIServiceClient aiServiceClient = mock(AIServiceClient.class);
        HealthController controller = new HealthController(redisTemplate, aiServiceClient);

        Map<String, Object> response = controller.health();

        assertEquals("UP", response.get("status"));
        assertEquals("processing-service", response.get("service"));
        assertEquals("ok", response.get("legacyStatus"));
        assertNotNull(response.get("timestamp"));
        assertEquals(Map.of(), response.get("dependencies"));
    }

    @Test
    void ready_shouldReturnUpWhenDependenciesHealthy() {
        StringRedisTemplate redisTemplate = mock(StringRedisTemplate.class);
        RedisConnectionFactory connectionFactory = mock(RedisConnectionFactory.class);
        RedisConnection connection = mock(RedisConnection.class);
        when(redisTemplate.getConnectionFactory()).thenReturn(connectionFactory);
        when(connectionFactory.getConnection()).thenReturn(connection);
        when(connection.ping()).thenReturn("PONG");

        AIServiceClient aiServiceClient = mock(AIServiceClient.class);
        HealthController controller = new HealthController(redisTemplate, aiServiceClient);

        ResponseEntity<Map<String, Object>> response = controller.ready();

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("UP", response.getBody().get("status"));
        @SuppressWarnings("unchecked")
        Map<String, String> dependencies = (Map<String, String>) response.getBody().get("dependencies");
        assertEquals("UP", dependencies.get("redis"));
        assertEquals("UP", dependencies.get("aiService"));
        verify(aiServiceClient).ready();
    }

    @Test
    void ready_shouldReturnServiceUnavailableWhenAiServiceIsDown() {
        StringRedisTemplate redisTemplate = mock(StringRedisTemplate.class);
        RedisConnectionFactory connectionFactory = mock(RedisConnectionFactory.class);
        RedisConnection connection = mock(RedisConnection.class);
        when(redisTemplate.getConnectionFactory()).thenReturn(connectionFactory);
        when(connectionFactory.getConnection()).thenReturn(connection);
        when(connection.ping()).thenReturn("PONG");

        AIServiceClient aiServiceClient = mock(AIServiceClient.class);
        doThrow(new IllegalStateException("ai down")).when(aiServiceClient).ready();

        HealthController controller = new HealthController(redisTemplate, aiServiceClient);
        ResponseEntity<Map<String, Object>> response = controller.ready();

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        assertEquals("DOWN", response.getBody().get("status"));
        assertEquals("not_ready", response.getBody().get("legacyStatus"));
        @SuppressWarnings("unchecked")
        Map<String, String> dependencies = (Map<String, String>) response.getBody().get("dependencies");
        assertEquals("UP", dependencies.get("redis"));
        assertEquals("DOWN", dependencies.get("aiService"));
    }
}
