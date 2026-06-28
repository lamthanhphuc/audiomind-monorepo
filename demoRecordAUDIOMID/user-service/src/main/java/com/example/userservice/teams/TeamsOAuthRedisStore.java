package com.example.userservice.teams;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

@Component
public class TeamsOAuthRedisStore {

    private static final String STATE_PREFIX = "teams_oauth_state:";
    private static final String ACCESS_TOKEN_PREFIX = "teams:access_token:";

    private final StringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper;
    private final TeamsOAuthProperties properties;

    public TeamsOAuthRedisStore(StringRedisTemplate redisTemplate, TeamsOAuthProperties properties) {
        this.redisTemplate = redisTemplate;
        this.objectMapper = new ObjectMapper().findAndRegisterModules();
        this.properties = properties;
    }

    public void saveLinkState(String state, Long userId, String redirectAfter) {
        TeamsLinkState value = new TeamsLinkState(userId, redirectAfter, Instant.now());
        redisTemplate.opsForValue().set(
                STATE_PREFIX + state,
                write(value),
                properties.getStateTtl());
    }

    public TeamsLinkState consumeLinkState(String state) {
        if (state == null || state.isBlank()) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_STATE_INVALID);
        }
        String value = redisTemplate.opsForValue().getAndDelete(STATE_PREFIX + state);
        if (value == null) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_STATE_INVALID);
        }
        return read(value, TeamsLinkState.class);
    }

    public String getAccessToken(Long userId) {
        return redisTemplate.opsForValue().get(ACCESS_TOKEN_PREFIX + userId);
    }

    public void saveAccessToken(Long userId, String accessToken, java.time.Duration ttl) {
        redisTemplate.opsForValue().set(ACCESS_TOKEN_PREFIX + userId, accessToken, ttl);
    }

    public void clearAccessToken(Long userId) {
        redisTemplate.delete(ACCESS_TOKEN_PREFIX + userId);
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialize Teams OAuth state", ex);
        }
    }

    private <T> T read(String value, Class<T> type) {
        try {
            return objectMapper.readValue(value, type);
        } catch (JsonProcessingException ex) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_STATE_INVALID, ex);
        }
    }

    public record TeamsLinkState(Long userId, String redirectAfter, Instant createdAt) {
    }
}
