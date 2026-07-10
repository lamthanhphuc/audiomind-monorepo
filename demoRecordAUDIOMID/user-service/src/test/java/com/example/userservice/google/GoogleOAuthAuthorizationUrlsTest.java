package com.example.userservice.google;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.web.util.UriComponentsBuilder;

class GoogleOAuthAuthorizationUrlsTest {

    private GoogleOAuthProperties properties;

    @BeforeEach
    void setUp() {
        properties = new GoogleOAuthProperties();
        properties.setClientId("test-client");
        properties.setRedirectUri("http://localhost:8083/auth/google/callback");
        properties.setLinkRedirectUri("http://localhost:8083/auth/google/link/callback");
    }

    @Test
    void buildLoginAuthorization_requestsOnlyIdentityScopesWithoutOfflineAccess() {
        URI uri = GoogleOAuthAuthorizationUrls.buildLoginAuthorization(properties, "state-1", "nonce-1");
        var params = UriComponentsBuilder.fromUri(uri).build().getQueryParams();

        assertThat(URLDecoder.decode(params.getFirst("scope"), StandardCharsets.UTF_8))
                .isEqualTo("openid email profile");
        assertThat(params.getFirst("redirect_uri")).isEqualTo(properties.getRedirectUri());
        assertThat(params.getFirst("state")).isEqualTo("state-1");
        assertThat(params.getFirst("nonce")).isEqualTo("nonce-1");
        assertThat(params.containsKey("access_type")).isFalse();
        assertThat(params.containsKey("prompt")).isFalse();
        assertThat(params.containsKey("include_granted_scopes")).isFalse();
        assertThat(uri.toString()).doesNotContain("calendar").doesNotContain("gmail");
    }

    @Test
    void buildIntegrationAuthorization_requestsAdditionalScopesWithOfflineAccess() {
        URI uri = GoogleOAuthAuthorizationUrls.buildIntegrationAuthorization(
                properties,
                List.of(GoogleScopes.CALENDAR_EVENTS),
                "state-2",
                "nonce-2",
                Optional.of("user@example.com"));
        var params = UriComponentsBuilder.fromUri(uri).build().getQueryParams();

        assertThat(params.getFirst("scope"))
                .contains("openid")
                .contains("email")
                .contains("profile")
                .contains(GoogleScopes.CALENDAR_EVENTS)
                .doesNotContain(GoogleScopes.GMAIL_SEND);
        assertThat(params.getFirst("redirect_uri")).isEqualTo(properties.getLinkRedirectUri());
        assertThat(params.getFirst("access_type")).isEqualTo("offline");
        assertThat(params.getFirst("include_granted_scopes")).isEqualTo("true");
        assertThat(params.getFirst("prompt")).isEqualTo("consent");
        assertThat(params.getFirst("login_hint")).isEqualTo("user@example.com");
    }

    @Test
    void buildIntegrationAuthorization_canRequestGmailScopeOnly() {
        URI uri = GoogleOAuthAuthorizationUrls.buildIntegrationAuthorization(
                properties,
                List.of(GoogleScopes.GMAIL_SEND),
                "state-3",
                "nonce-3",
                Optional.empty());
        var params = UriComponentsBuilder.fromUri(uri).build().getQueryParams();

        assertThat(params.getFirst("scope"))
                .contains(GoogleScopes.GMAIL_SEND)
                .doesNotContain(GoogleScopes.CALENDAR_EVENTS);
    }
}
