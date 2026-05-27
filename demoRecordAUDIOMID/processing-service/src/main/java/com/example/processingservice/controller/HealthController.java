package com.example.processingservice.controller;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.data.redis.core.StringRedisTemplate;
import com.example.processingservice.client.AIServiceClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class HealthController {

    private final StringRedisTemplate redisTemplate;
    private final AIServiceClient aiServiceClient;

    @GetMapping("/health")
    public Map<String, Object> health() {
        return buildPayload("UP", "ok", Map.of());
    }

    @GetMapping("/ready")
    public ResponseEntity<Map<String, Object>> ready() {
        Map<String, String> dependencies = new LinkedHashMap<>();
        boolean ready = true;

        try {
            var connectionFactory = redisTemplate.getConnectionFactory();
            if (connectionFactory == null) {
                throw new IllegalStateException("Redis connection factory unavailable");
            }
            try (var connection = connectionFactory.getConnection()) {
                String ping = connection.ping();
                if (ping == null || ping.isBlank()) {
                    throw new IllegalStateException("Redis ping returned empty response");
                }
            }
            dependencies.put("redis", "UP");
        } catch (Exception ex) {
            dependencies.put("redis", "DOWN");
            ready = false;
        }

        try {
            aiServiceClient.ready();
            dependencies.put("aiService", "UP");
        } catch (Exception ex) {
            dependencies.put("aiService", "DOWN");
            ready = false;
        }

        if (!ready) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(buildPayload("DOWN", "not_ready", dependencies));
        }

        return ResponseEntity.ok(buildPayload("UP", "ready", dependencies));
    }

    private Map<String, Object> buildPayload(
        String status,
        String legacyStatus,
        Map<String, String> dependencies
    ) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("status", status);
        payload.put("service", "processing-service");
        payload.put("timestamp", Instant.now().toString());
        payload.put("dependencies", dependencies);
        payload.put("legacyStatus", legacyStatus);
        return payload;
    }
}
