package com.example.userservice.google;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import org.springframework.web.util.UriComponentsBuilder;

public final class GoogleOAuthAuthorizationUrls {

    private static final String GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

    private GoogleOAuthAuthorizationUrls() {
    }

    public static URI buildLoginAuthorization(
            GoogleOAuthProperties properties,
            String state,
            String nonce) {
        return UriComponentsBuilder.fromUriString(GOOGLE_AUTH_ENDPOINT)
                .queryParam("client_id", properties.getClientId())
                .queryParam("redirect_uri", properties.getRedirectUri())
                .queryParam("response_type", "code")
                .queryParam("scope", String.join(" ", GoogleScopes.IDENTITY))
                .queryParam("state", state)
                .queryParam("nonce", nonce)
                .build()
                .encode()
                .toUri();
    }

    public static URI buildIntegrationAuthorization(
            GoogleOAuthProperties properties,
            Collection<String> additionalScopes,
            String state,
            String nonce,
            Optional<String> loginHint) {
        List<String> scopes = new ArrayList<>(GoogleScopes.IDENTITY);
        scopes.addAll(additionalScopes);

        UriComponentsBuilder auth = UriComponentsBuilder.fromUriString(GOOGLE_AUTH_ENDPOINT)
                .queryParam("client_id", properties.getClientId())
                .queryParam("redirect_uri", properties.getLinkRedirectUri())
                .queryParam("response_type", "code")
                .queryParam("scope", String.join(" ", scopes))
                .queryParam("state", state)
                .queryParam("nonce", nonce)
                .queryParam("access_type", "offline")
                .queryParam("include_granted_scopes", "true")
                .queryParam("prompt", "consent");
        loginHint.filter(email -> !email.isBlank()).ifPresent(email -> auth.queryParam("login_hint", email));
        return auth.build().encode().toUri();
    }
}
