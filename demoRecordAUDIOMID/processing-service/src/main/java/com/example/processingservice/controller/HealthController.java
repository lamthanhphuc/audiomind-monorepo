package com.example.processingservice.controller;

import java.util.Map;
import lombok.RequiredArgsConstructor;
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
    public Map<String, String> health() {
        return Map.of("status", "ok", "service", "processing-service");
    }

    @GetMapping("/ready")
    public Map<String, String> ready() {
        redisTemplate.getConnectionFactory().getConnection().ping();
        aiServiceClient.health();
        return Map.of("status", "ready", "service", "processing-service");
    }
}
