package com.example.userservice.google;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.GoogleOAuthGrant;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.google.GoogleScopes;
import com.example.userservice.repository.GoogleOAuthGrantRepository;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserIdentityRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

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
}
