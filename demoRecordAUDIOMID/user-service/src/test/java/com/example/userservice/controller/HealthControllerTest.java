package com.example.userservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.example.userservice.repository.UserAccountRepository;
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
        UserAccountRepository userAccountRepository = mock(UserAccountRepository.class);
        StringRedisTemplate redisTemplate = mock(StringRedisTemplate.class);
        HealthController controller = new HealthController(userAccountRepository, redisTemplate);

        Map<String, Object> response = controller.health();

        assertEquals("UP", response.get("status"));
        assertEquals("user-service", response.get("service"));
        assertEquals("ok", response.get("legacyStatus"));
        assertNotNull(response.get("timestamp"));
        assertEquals(Map.of(), response.get("dependencies"));
    }

    @Test
    void ready_shouldReturnUpWhenDependenciesAreHealthy() {
        UserAccountRepository userAccountRepository = mock(UserAccountRepository.class);
        when(userAccountRepository.count()).thenReturn(1L);

        StringRedisTemplate redisTemplate = mock(StringRedisTemplate.class);
        RedisConnectionFactory connectionFactory = mock(RedisConnectionFactory.class);
        RedisConnection connection = mock(RedisConnection.class);
        when(redisTemplate.getConnectionFactory()).thenReturn(connectionFactory);
        when(connectionFactory.getConnection()).thenReturn(connection);
        when(connection.ping()).thenReturn("PONG");

        HealthController controller = new HealthController(userAccountRepository, redisTemplate);
        ResponseEntity<Map<String, Object>> response = controller.ready();

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("UP", response.getBody().get("status"));
        @SuppressWarnings("unchecked")
        Map<String, String> dependencies = (Map<String, String>) response.getBody().get("dependencies");
        assertEquals("UP", dependencies.get("database"));
        assertEquals("UP", dependencies.get("redis"));
    }

    @Test
    void ready_shouldReturnServiceUnavailableWhenRedisFails() {
        UserAccountRepository userAccountRepository = mock(UserAccountRepository.class);
        when(userAccountRepository.count()).thenReturn(1L);

        StringRedisTemplate redisTemplate = mock(StringRedisTemplate.class);
        RedisConnectionFactory connectionFactory = mock(RedisConnectionFactory.class);
        when(redisTemplate.getConnectionFactory()).thenReturn(connectionFactory);
        doThrow(new IllegalStateException("redis down")).when(connectionFactory).getConnection();

        HealthController controller = new HealthController(userAccountRepository, redisTemplate);
        ResponseEntity<Map<String, Object>> response = controller.ready();

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        assertEquals("DOWN", response.getBody().get("status"));
        @SuppressWarnings("unchecked")
        Map<String, String> dependencies = (Map<String, String>) response.getBody().get("dependencies");
        assertEquals("UP", dependencies.get("database"));
        assertEquals("DOWN", dependencies.get("redis"));
    }
}
