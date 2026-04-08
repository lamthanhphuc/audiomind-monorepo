package com.example.userservice.security;

import java.time.Duration;
import lombok.RequiredArgsConstructor;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

@Component
@RequiredArgsConstructor
public class RedisTokenBlacklistStore implements TokenBlacklistStore {

    private static final String PREFIX = "blacklist:";

    private final StringRedisTemplate redisTemplate;

    @Override
    public void blacklist(String token, long ttlSeconds) {
        if (token == null || token.isBlank() || ttlSeconds <= 0) {
            return;
        }
        redisTemplate.opsForValue().set(PREFIX + token, "1", Duration.ofSeconds(ttlSeconds));
    }

    @Override
    public boolean isBlacklisted(String token) {
        if (token == null || token.isBlank()) {
            return false;
        }
        return Boolean.TRUE.equals(redisTemplate.hasKey(PREFIX + token));
    }
}
