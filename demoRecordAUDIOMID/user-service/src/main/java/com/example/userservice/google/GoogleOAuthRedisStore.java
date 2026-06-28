package com.example.userservice.google;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

@Component
public class GoogleOAuthRedisStore {

    private static final String STATE_PREFIX = "google_oauth_state:";
    private static final String TICKET_PREFIX = "google_login_ticket:";
    private static final String ISSUED_PREFIX = "google_login_ticket_issued:";
    private static final String USED_PREFIX = "google_login_ticket_used:";
    private static final String ACCESS_TOKEN_PREFIX = "google:access_token:";
    private static final String ACCESS_TOKEN_INDEX_PREFIX = "google:access_token_keys:";

    private final StringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper;
    private final GoogleOAuthProperties properties;

    public GoogleOAuthRedisStore(
            StringRedisTemplate redisTemplate,
            GoogleOAuthProperties properties) {
        this.redisTemplate = redisTemplate;
        this.objectMapper = new ObjectMapper().findAndRegisterModules();
        this.properties = properties;
    }

    public void saveState(String state, String nonce, String redirectAfter) {
        GoogleLoginState value = new GoogleLoginState("login", nonce, redirectAfter, Instant.now());
        redisTemplate.opsForValue().set(
                STATE_PREFIX + state,
                write(value),
                properties.getStateTtl());
    }

    public void saveLinkState(
            String state,
            String nonce,
            Long userId,
            java.util.List<String> requestedScopes,
            String redirectAfter) {
        GoogleLoginState value = new GoogleLoginState(
                "link", nonce, redirectAfter, Instant.now(), userId, requestedScopes);
        redisTemplate.opsForValue().set(
                STATE_PREFIX + state,
                write(value),
                properties.getStateTtl());
    }

    public GoogleLoginState consumeState(String state) {
        return consumeState(state, "login");
    }

    public GoogleLoginState consumeLinkState(String state) {
        return consumeState(state, "link");
    }

    private GoogleLoginState consumeState(String state, String expectedMode) {
        if (state == null || state.isBlank()) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_STATE_INVALID);
        }
        String value = redisTemplate.opsForValue().getAndDelete(STATE_PREFIX + state);
        if (value == null) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_STATE_INVALID);
        }
        GoogleLoginState loginState = read(value, GoogleLoginState.class);
        if (!expectedMode.equals(loginState.mode())) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_STATE_INVALID);
        }
        return loginState;
    }

    public String getAccessToken(Long userId, String scopeHash) {
        return redisTemplate.opsForValue().get(accessTokenKey(userId, scopeHash));
    }

    public void saveAccessToken(Long userId, String scopeHash, String accessToken, java.time.Duration ttl) {
        String key = accessTokenKey(userId, scopeHash);
        redisTemplate.opsForValue().set(key, accessToken, ttl);
        redisTemplate.opsForSet().add(ACCESS_TOKEN_INDEX_PREFIX + userId, key);
        redisTemplate.expire(ACCESS_TOKEN_INDEX_PREFIX + userId, ttl.plus(properties.getStateTtl()));
    }

    public void clearAccessTokens(Long userId) {
        String indexKey = ACCESS_TOKEN_INDEX_PREFIX + userId;
        java.util.Set<String> keys = redisTemplate.opsForSet().members(indexKey);
        if (keys != null && !keys.isEmpty()) {
            redisTemplate.delete(keys);
        }
        redisTemplate.delete(indexKey);
    }

    public String scopeHash(java.util.Collection<String> scopes) {
        return hash(scopes.stream().sorted().collect(java.util.stream.Collectors.joining(" ")));
    }

    private String accessTokenKey(Long userId, String scopeHash) {
        return ACCESS_TOKEN_PREFIX + userId + ":" + scopeHash;
    }

    public void saveTicket(String rawTicket, Long userId, String redirectAfter) {
        String ticketHash = hash(rawTicket);
        GoogleLoginTicket value = new GoogleLoginTicket(userId, redirectAfter, Instant.now());
        redisTemplate.opsForValue().set(TICKET_PREFIX + ticketHash, write(value), properties.getTicketTtl());
        redisTemplate.opsForValue().set(ISSUED_PREFIX + ticketHash, "1", properties.getTicketMarkerTtl());
    }

    public GoogleLoginTicket consumeTicket(String rawTicket) {
        if (rawTicket == null || rawTicket.length() < 32) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_LOGIN_TICKET_INVALID);
        }
        String ticketHash = hash(rawTicket);
        String value = redisTemplate.opsForValue().getAndDelete(TICKET_PREFIX + ticketHash);
        if (value == null) {
            if (Boolean.TRUE.equals(redisTemplate.hasKey(USED_PREFIX + ticketHash))) {
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_LOGIN_TICKET_USED);
            }
            if (Boolean.TRUE.equals(redisTemplate.hasKey(ISSUED_PREFIX + ticketHash))) {
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_LOGIN_TICKET_EXPIRED);
            }
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_LOGIN_TICKET_INVALID);
        }
        redisTemplate.delete(ISSUED_PREFIX + ticketHash);
        redisTemplate.opsForValue().set(USED_PREFIX + ticketHash, "1", properties.getTicketMarkerTtl());
        return read(value, GoogleLoginTicket.class);
    }

    private String hash(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }

    private String write(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialize Google OAuth state", ex);
        }
    }

    private <T> T read(String value, Class<T> type) {
        try {
            return objectMapper.readValue(value, type);
        } catch (JsonProcessingException ex) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_STATE_INVALID, ex);
        }
    }
}
