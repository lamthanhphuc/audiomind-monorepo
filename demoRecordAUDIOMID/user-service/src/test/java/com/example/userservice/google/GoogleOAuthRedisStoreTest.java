package com.example.userservice.google;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Duration;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

@ExtendWith(MockitoExtension.class)
class GoogleOAuthRedisStoreTest {

    @Mock private StringRedisTemplate redisTemplate;
    @Mock private ValueOperations<String, String> valueOperations;

    private GoogleOAuthRedisStore store;

    @BeforeEach
    void setUp() {
        GoogleOAuthProperties properties = new GoogleOAuthProperties();
        properties.setStateTtl(Duration.ofMinutes(10));
        properties.setTicketTtl(Duration.ofSeconds(90));
        properties.setTicketMarkerTtl(Duration.ofMinutes(10));
        when(redisTemplate.opsForValue()).thenReturn(valueOperations);
        store = new GoogleOAuthRedisStore(redisTemplate, properties);
    }

    @Test
    void consumesStateAtomically() throws Exception {
        String payload = new ObjectMapper().findAndRegisterModules().writeValueAsString(
                new GoogleLoginState("login", "nonce", "/", java.time.Instant.now()));
        when(valueOperations.getAndDelete("google_oauth_state:state-1")).thenReturn(payload);

        GoogleLoginState state = store.consumeState("state-1");

        assertEquals("nonce", state.nonce());
        verify(valueOperations).getAndDelete("google_oauth_state:state-1");
    }

    @Test
    void rejectsReusedTicketUsingUsedMarker() {
        when(valueOperations.getAndDelete(anyString())).thenReturn(null);
        when(redisTemplate.hasKey(anyString())).thenAnswer(invocation ->
                ((String) invocation.getArgument(0)).startsWith("google_login_ticket_used:"));

        GoogleOAuthException exception = assertThrows(
                GoogleOAuthException.class,
                () -> store.consumeTicket("abcdefghijklmnopqrstuvwxyz-1234567890"));

        assertEquals(GoogleOAuthError.GOOGLE_LOGIN_TICKET_USED, exception.error());
    }

    @Test
    void storesOnlyTicketHashInRedisKey() {
        String rawTicket = "abcdefghijklmnopqrstuvwxyz-1234567890";

        store.saveTicket(rawTicket, 71L, "/");

        verify(valueOperations).set(
                org.mockito.ArgumentMatchers.argThat(key ->
                        key.startsWith("google_login_ticket:") && !key.contains(rawTicket)),
                anyString(),
                eq(Duration.ofSeconds(90)));
    }
}
