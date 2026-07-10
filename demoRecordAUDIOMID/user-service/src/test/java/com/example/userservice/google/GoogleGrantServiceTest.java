package com.example.userservice.google;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.GoogleOAuthGrant;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserIdentity;
import com.example.userservice.google.GoogleScopes;
import com.example.userservice.repository.GoogleOAuthGrantRepository;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserIdentityRepository;
import java.net.URI;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.util.UriComponentsBuilder;

@ExtendWith(MockitoExtension.class)
class GoogleGrantServiceTest {

    @Mock
    private GoogleOAuthProperties properties;
    @Mock
    private GoogleOAuthRedisStore redisStore;
    @Mock
    private GoogleOAuthClient oauthClient;
    @Mock
    private GoogleTokenCipher tokenCipher;
    @Mock
    private GoogleOAuthGrantRepository grantRepository;
    @Mock
    private UserAccountRepository userRepository;
    @Mock
    private UserIdentityRepository identityRepository;

    private GoogleGrantService service;

    @BeforeEach
    void setUp() {
        service = new GoogleGrantService(
                properties,
                redisStore,
                oauthClient,
                tokenCipher,
                grantRepository,
                userRepository,
                identityRepository);
    }

    @Test
    void startLink_buildsAuthorizationUrlForRequestedScopesOnly() {
        GoogleOAuthProperties linkProperties = configuredGrantProperties();
        GoogleGrantService linkService = new GoogleGrantService(
                linkProperties,
                redisStore,
                oauthClient,
                tokenCipher,
                grantRepository,
                userRepository,
                identityRepository);

        UserAccount user = new UserAccount();
        user.setId(9L);
        when(userRepository.findById(9L)).thenReturn(Optional.of(user));
        when(identityRepository.findByUserIdAndProviderAndUnlinkedAtIsNull(9L, "google"))
                .thenReturn(Optional.of(new UserIdentity()));

        URI uri = linkService.startLink(9L, List.of(GoogleScopes.CALENDAR_EVENTS), "/studio/integrations");
        var params = UriComponentsBuilder.fromUri(uri).build().getQueryParams();

        assertThat(params.getFirst("scope"))
                .contains(GoogleScopes.CALENDAR_EVENTS)
                .doesNotContain(GoogleScopes.GMAIL_SEND);
        assertThat(params.getFirst("redirect_uri")).isEqualTo("http://localhost:8083/auth/google/link/callback");
        assertThat(params.getFirst("access_type")).isEqualTo("offline");
        verify(redisStore).saveLinkState(anyString(), anyString(), eq(9L), eq(List.of(GoogleScopes.CALENDAR_EVENTS)), eq("/studio/integrations"));
    }

    @Test
    void startLink_canRequestGmailScopeOnly() {
        GoogleOAuthProperties linkProperties = configuredGrantProperties();
        GoogleGrantService linkService = new GoogleGrantService(
                linkProperties,
                redisStore,
                oauthClient,
                tokenCipher,
                grantRepository,
                userRepository,
                identityRepository);

        UserAccount user = new UserAccount();
        user.setId(10L);
        when(userRepository.findById(10L)).thenReturn(Optional.of(user));
        when(identityRepository.findByUserIdAndProviderAndUnlinkedAtIsNull(10L, "google"))
                .thenReturn(Optional.empty());

        URI uri = linkService.startLink(10L, List.of(GoogleScopes.GMAIL_SEND), "/studio/integrations");
        var params = UriComponentsBuilder.fromUri(uri).build().getQueryParams();

        assertThat(params.getFirst("scope"))
                .contains(GoogleScopes.GMAIL_SEND)
                .doesNotContain(GoogleScopes.CALENDAR_EVENTS);
    }

    @Test
    void accessTokenFailsWhenRequiredScopeMissing() {
        GoogleOAuthGrant grant = new GoogleOAuthGrant();
        grant.setGrantedScopes(List.of("openid", "email"));
        when(grantRepository.findByUserIdAndRevokedAtIsNull(7L)).thenReturn(Optional.of(grant));

        assertThatThrownBy(() -> service.accessToken(
                7L,
                List.of("https://www.googleapis.com/auth/calendar.events")))
                .isInstanceOf(GoogleOAuthException.class)
                .extracting(ex -> ((GoogleOAuthException) ex).error())
                .isEqualTo(GoogleOAuthError.GOOGLE_SCOPE_MISSING);
    }

    @Test
    void hasScope_returnsTrueWhenGrantContainsScope() {
        GoogleOAuthGrant grant = new GoogleOAuthGrant();
        grant.setGrantedScopes(List.of(GoogleScopes.CALENDAR_EVENTS, GoogleScopes.GMAIL_SEND));
        when(grantRepository.findByUserIdAndRevokedAtIsNull(7L)).thenReturn(Optional.of(grant));

        assertThat(service.hasScope(7L, GoogleScopes.GMAIL_SEND)).isTrue();
        assertThat(service.hasScope(7L, GoogleScopes.CALENDAR_EVENTS)).isTrue();
    }

    @Test
    void hasScope_returnsFalseWhenGrantMissingScope() {
        GoogleOAuthGrant grant = new GoogleOAuthGrant();
        grant.setGrantedScopes(List.of(GoogleScopes.CALENDAR_EVENTS));
        when(grantRepository.findByUserIdAndRevokedAtIsNull(7L)).thenReturn(Optional.of(grant));

        assertThat(service.hasScope(7L, GoogleScopes.GMAIL_SEND)).isFalse();
    }

    @Test
    void link_persistsOnlyScopesReturnedByGoogle_notRequestedScopes() {
        UserAccount user = new UserAccount();
        user.setId(1L);
        when(userRepository.findById(1L)).thenReturn(Optional.of(user));
        when(identityRepository.findByProviderAndProviderSubAndUnlinkedAtIsNull(anyString(), anyString()))
                .thenReturn(Optional.empty());
        when(identityRepository.findByUserIdAndProviderAndUnlinkedAtIsNull(1L, "google"))
                .thenReturn(Optional.empty());
        when(grantRepository.findByUserIdAndRevokedAtIsNull(1L)).thenReturn(Optional.empty());
        when(grantRepository.findFirstByUserIdOrderByUpdatedAtDesc(1L)).thenReturn(Optional.empty());
        when(grantRepository.findByGoogleSubAndRevokedAtIsNull(anyString())).thenReturn(Optional.empty());
        when(tokenCipher.encrypt(anyString())).thenReturn(new GoogleTokenCipher.EncryptedToken("ct", "iv", "kid"));

        GoogleIdentity identity = new GoogleIdentity("google-sub", "user@example.com", true, "User", null);
        GoogleTokenResponse tokens = new GoogleTokenResponse(
                "access-token",
                3600L,
                "refresh-token",
                "id-token",
                "openid email profile " + GoogleScopes.GMAIL_SEND,
                "Bearer");

        service.link(
                1L,
                identity,
                tokens,
                List.of(GoogleScopes.CALENDAR_EVENTS, GoogleScopes.GMAIL_SEND));

        ArgumentCaptor<GoogleOAuthGrant> captor = ArgumentCaptor.forClass(GoogleOAuthGrant.class);
        verify(grantRepository).save(captor.capture());
        assertThat(captor.getValue().getGrantedScopes())
                .contains(GoogleScopes.GMAIL_SEND)
                .doesNotContain(GoogleScopes.CALENDAR_EVENTS);
    }

    private static GoogleOAuthProperties configuredGrantProperties() {
        GoogleOAuthProperties properties = new GoogleOAuthProperties();
        properties.setEnabled(true);
        properties.setClientId("client-id");
        properties.setClientSecret("client-secret");
        properties.setRedirectUri("http://localhost:8083/auth/google/callback");
        properties.setLinkRedirectUri("http://localhost:8083/auth/google/link/callback");
        properties.setFrontendBaseUrl("http://localhost:8080");
        properties.setTokenEncryptionKey("01234567890123456789012345678901");
        properties.setTokenEncryptionKid("v1");
        properties.setInternalServiceToken("internal-token");
        return properties;
    }
}
