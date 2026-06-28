package com.example.userservice.google;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.client.PendingMeetingShareClient;
import com.example.userservice.controller.dto.GoogleTicketExchangeResponse;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserIdentity;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserIdentityRepository;
import com.example.userservice.security.JwtUtil;
import java.net.URI;
import java.time.Instant;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class GoogleLoginServiceTest {

    @Mock private GoogleOAuthRedisStore redisStore;
    @Mock private GoogleOAuthClient googleOAuthClient;
    @Mock private GoogleUserProvisioningService provisioningService;
    @Mock private UserAccountRepository userAccountRepository;
    @Mock private UserIdentityRepository userIdentityRepository;
    @Mock private JwtUtil jwtUtil;
    @Mock private GoogleGrantService googleGrantService;
    @Mock private PendingMeetingShareClient pendingMeetingShareClient;

    private GoogleOAuthProperties properties;
    private GoogleLoginService service;

    @BeforeEach
    void setUp() {
        properties = new GoogleOAuthProperties();
        properties.setEnabled(true);
        properties.setClientId("client-id");
        properties.setClientSecret("client-secret");
        properties.setRedirectUri("http://localhost:8083/auth/google/callback");
        properties.setFrontendBaseUrl("http://localhost:8080");
        service = new GoogleLoginService(
                properties,
                redisStore,
                googleOAuthClient,
                provisioningService,
                userAccountRepository,
                userIdentityRepository,
                jwtUtil,
                googleGrantService,
                pendingMeetingShareClient,
                3600L);
    }

    @Test
    void startLoginCreatesOpaqueStateAndMinimalScopes() {
        URI redirect = service.startLogin("/meetings");

        assertEquals("accounts.google.com", redirect.getHost());
        assertTrue(redirect.getQuery().contains("scope=openid%20email%20profile")
                || redirect.toString().contains("scope=openid%20email%20profile"));
        assertFalse(redirect.toString().contains("calendar"));
        verify(redisStore).saveState(anyString(), anyString(), eq("/meetings"));
    }

    @Test
    void callbackCreatesOneTimeTicketAndRedirectsWithoutJwt() {
        GoogleLoginState state = new GoogleLoginState("login", "nonce-1", "/", Instant.now());
        GoogleTokenResponse tokenResponse = new GoogleTokenResponse("access", 3600L, "id-token", "openid", "Bearer");
        GoogleIdentity identity = new GoogleIdentity("sub", "user@example.com", true, "User", null);
        UserAccount user = new UserAccount();
        user.setId(51L);
        user.setEmail("user@example.com");
        when(redisStore.consumeState("state-1")).thenReturn(state);
        when(googleOAuthClient.exchangeCode("code-1")).thenReturn(tokenResponse);
        when(googleOAuthClient.verifyIdToken("id-token", "nonce-1")).thenReturn(identity);
        when(provisioningService.findOrCreate(identity)).thenReturn(user);

        URI redirect = service.handleCallback("code-1", "state-1", null);

        assertTrue(redirect.getPath().endsWith("/auth/google/success"));
        assertTrue(redirect.getQuery().startsWith("ticket="));
        assertFalse(redirect.toString().contains("jwt"));
        verify(pendingMeetingShareClient).acceptPendingInvites(51L, "user@example.com");
        verify(redisStore).saveTicket(anyString(), eq(51L), eq("/"));
    }

    @Test
    void exchangesTicketForAudiomindJwt() {
        when(redisStore.consumeTicket("raw-ticket"))
                .thenReturn(new GoogleLoginTicket(61L, "/dashboard", Instant.now()));
        UserAccount user = new UserAccount();
        user.setId(61L);
        user.setUsername("google_user");
        user.setEmail("user@example.com");
        user.setRole("ADMIN");
        user.setPlan("PRO");
        UserIdentity identity = new UserIdentity();
        identity.setDisplayName("Google User");
        when(userAccountRepository.findById(61L)).thenReturn(Optional.of(user));
        when(userIdentityRepository.findByUserIdAndProviderAndUnlinkedAtIsNull(61L, "google"))
                .thenReturn(Optional.of(identity));
        when(jwtUtil.createAccessToken(61L, "google_user", "ADMIN", "PRO")).thenReturn("audiomind-jwt");

        GoogleTicketExchangeResponse response = service.exchangeTicket("raw-ticket");

        assertEquals("audiomind-jwt", response.token());
        assertEquals(61L, response.user().id());
        assertEquals("/dashboard", response.redirectAfter());
    }
}
