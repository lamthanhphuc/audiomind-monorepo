package com.example.userservice.google;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.api.client.googleapis.auth.oauth2.GoogleIdToken;
import com.google.api.client.googleapis.auth.oauth2.GoogleIdTokenVerifier;
import com.google.api.client.googleapis.javanet.GoogleNetHttpTransport;
import com.google.api.client.json.gson.GsonFactory;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class GoogleOAuthClient {

    private static final Logger log = LoggerFactory.getLogger(GoogleOAuthClient.class);
    private static final URI TOKEN_ENDPOINT = URI.create("https://oauth2.googleapis.com/token");
    private static final URI REVOCATION_ENDPOINT = URI.create("https://oauth2.googleapis.com/revoke");
    private static final URI USERINFO_ENDPOINT = URI.create("https://www.googleapis.com/oauth2/v3/userinfo");

    private final GoogleOAuthProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final GoogleIdTokenVerifier idTokenVerifier;

    public GoogleOAuthClient(GoogleOAuthProperties properties) {
        this.properties = properties;
        this.objectMapper = new ObjectMapper().findAndRegisterModules();
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        try {
            this.idTokenVerifier = new GoogleIdTokenVerifier.Builder(
                    GoogleNetHttpTransport.newTrustedTransport(),
                    GsonFactory.getDefaultInstance())
                    .setAudience(List.of(properties.getClientId()))
                    .build();
        } catch (GeneralSecurityException | IOException ex) {
            throw new IllegalStateException("Unable to initialize Google ID token verifier", ex);
        }
    }

    public GoogleTokenResponse exchangeCode(String code) {
        return exchangeCode(code, properties.getRedirectUri());
    }

    public GoogleTokenResponse exchangeCode(String code, String redirectUri) {
        properties.requireConfigured();
        String form = "code=" + encode(code)
                + "&client_id=" + encode(properties.getClientId())
                + "&client_secret=" + encode(properties.getClientSecret())
                + "&redirect_uri=" + encode(redirectUri)
                + "&grant_type=authorization_code";
        HttpRequest request = HttpRequest.newBuilder(TOKEN_ENDPOINT)
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();

        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.warn(
                        "event=GOOGLE_TOKEN_EXCHANGE_FAILED httpStatus={} googleError={}",
                        response.statusCode(),
                        sanitizeGoogleError(response.body()));
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
            GoogleTokenResponse tokenResponse;
            try {
                tokenResponse = objectMapper.readValue(response.body(), GoogleTokenResponse.class);
            } catch (IOException parseEx) {
                log.warn(
                        "event=GOOGLE_TOKEN_EXCHANGE_PARSE_FAILED error={}",
                        parseEx.getClass().getSimpleName());
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, parseEx);
            }
            if (tokenResponse.idToken() == null || tokenResponse.idToken().isBlank()) {
                if (tokenResponse.accessToken() == null || tokenResponse.accessToken().isBlank()) {
                    throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
                }
                return tokenResponse;
            }
            return tokenResponse;
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, ex);
        } catch (IOException ex) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    public GoogleTokenResponse refreshAccessToken(String refreshToken) {
        properties.requireGrantConfigured();
        String form = "client_id=" + encode(properties.getClientId())
                + "&client_secret=" + encode(properties.getClientSecret())
                + "&refresh_token=" + encode(refreshToken)
                + "&grant_type=refresh_token";
        return sendTokenRequest(form, true);
    }

    public void revokeToken(String refreshToken) {
        properties.requireGrantConfigured();
        HttpRequest request = HttpRequest.newBuilder(REVOCATION_ENDPOINT)
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString("token=" + encode(refreshToken)))
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, ex);
        } catch (IOException ex) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    private GoogleTokenResponse sendTokenRequest(String form, boolean refresh) {
        HttpRequest request = HttpRequest.newBuilder(TOKEN_ENDPOINT)
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                boolean invalidGrant = refresh && response.body() != null
                        && response.body().contains("invalid_grant");
                throw new GoogleOAuthException(invalidGrant
                        ? GoogleOAuthError.GOOGLE_REFRESH_TOKEN_REVOKED
                        : GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
            return objectMapper.readValue(response.body(), GoogleTokenResponse.class);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, ex);
        } catch (IOException ex) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    public GoogleIdentity verifyIdToken(String rawIdToken, String expectedNonce) {
        return verifyIdToken(rawIdToken, expectedNonce, true);
    }

    /** Link/incremental grant flow: Google may omit nonce in id_token even when auth request included it. */
    public GoogleIdentity verifyIdTokenForLink(String rawIdToken, String expectedNonce) {
        return verifyIdToken(rawIdToken, expectedNonce, false);
    }

    public GoogleIdentity fetchIdentityFromAccessToken(String accessToken) {
        properties.requireConfigured();
        HttpRequest request = HttpRequest.newBuilder(USERINFO_ENDPOINT)
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer " + accessToken)
                .GET()
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                log.warn(
                        "event=GOOGLE_USERINFO_FAILED httpStatus={}",
                        response.statusCode());
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
            Map<?, ?> payload = objectMapper.readValue(response.body(), Map.class);
            String subject = stringValue(payload.get("sub"));
            String email = stringValue(payload.get("email"));
            if (subject == null || subject.isBlank() || email == null || email.isBlank()) {
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
            return new GoogleIdentity(
                    subject,
                    email,
                    Boolean.TRUE.equals(payload.get("email_verified")),
                    stringValue(payload.get("name")),
                    stringValue(payload.get("picture")));
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, ex);
        } catch (IOException ex) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    private GoogleIdentity verifyIdToken(String rawIdToken, String expectedNonce, boolean requireNonce) {
        properties.requireConfigured();
        try {
            GoogleIdToken idToken = idTokenVerifier.verify(rawIdToken);
            if (idToken == null) {
                log.warn("event=GOOGLE_ID_TOKEN_VERIFY_FAILED reason=invalid_signature");
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
            GoogleIdToken.Payload payload = idToken.getPayload();
            String nonce = (String) payload.get("nonce");
            if (requireNonce) {
                if (nonce == null || !constantTimeEquals(nonce, expectedNonce)) {
                    log.warn(
                            "event=GOOGLE_ID_TOKEN_VERIFY_FAILED reason=nonce_mismatch hasNonce={}",
                            nonce != null);
                    throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
                }
            } else if (nonce != null && !constantTimeEquals(nonce, expectedNonce)) {
                log.warn("event=GOOGLE_ID_TOKEN_VERIFY_FAILED reason=nonce_mismatch_link");
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
            if (!Boolean.TRUE.equals(payload.getEmailVerified())) {
                log.warn("event=GOOGLE_ID_TOKEN_VERIFY_FAILED reason=email_not_verified");
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
            String subject = payload.getSubject();
            String email = payload.getEmail();
            if (subject == null || subject.isBlank() || email == null || email.isBlank()) {
                log.warn("event=GOOGLE_ID_TOKEN_VERIFY_FAILED reason=missing_subject_or_email");
                throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
            return new GoogleIdentity(
                    subject,
                    email,
                    true,
                    stringValue(payload.get("name")),
                    stringValue(payload.get("picture")));
        } catch (GeneralSecurityException | IOException ex) {
            log.warn(
                    "event=GOOGLE_ID_TOKEN_VERIFY_FAILED reason=exception error={}",
                    ex.getClass().getSimpleName());
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    private boolean constantTimeEquals(String left, String right) {
        return java.security.MessageDigest.isEqual(
                left.getBytes(StandardCharsets.UTF_8),
                right.getBytes(StandardCharsets.UTF_8));
    }

    private String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private String sanitizeGoogleError(String body) {
        if (body == null || body.isBlank()) {
            return "empty";
        }
        try {
            Map<?, ?> payload = objectMapper.readValue(body, Map.class);
            Object error = payload.get("error");
            Object description = payload.get("error_description");
            return String.valueOf(error) + ":" + String.valueOf(description);
        } catch (IOException ex) {
            return "unparseable";
        }
    }
}
