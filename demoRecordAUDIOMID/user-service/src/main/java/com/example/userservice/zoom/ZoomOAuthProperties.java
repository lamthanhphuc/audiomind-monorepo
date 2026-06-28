package com.example.userservice.zoom;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "zoom.oauth")
public class ZoomOAuthProperties {

    private boolean enabled;
    private String clientId = "";
    private String clientSecret = "";
    private String redirectUri = "http://localhost:8083/auth/zoom/callback";
    private String frontendBaseUrl = "http://localhost:8080";
    private String tokenEncryptionKey = "";
    private String tokenEncryptionKid = "v1";
    private Duration stateTtl = Duration.ofMinutes(10);
    private List<String> allowedRedirectOrigins = new ArrayList<>(List.of(
            "http://localhost:8080",
            "http://127.0.0.1:8080"));

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getClientId() {
        return clientId;
    }

    public void setClientId(String clientId) {
        this.clientId = clientId;
    }

    public String getClientSecret() {
        return clientSecret;
    }

    public void setClientSecret(String clientSecret) {
        this.clientSecret = clientSecret;
    }

    public String getRedirectUri() {
        return redirectUri;
    }

    public void setRedirectUri(String redirectUri) {
        this.redirectUri = redirectUri;
    }

    public String getFrontendBaseUrl() {
        return frontendBaseUrl;
    }

    public void setFrontendBaseUrl(String frontendBaseUrl) {
        this.frontendBaseUrl = frontendBaseUrl;
    }

    public String getTokenEncryptionKey() {
        return tokenEncryptionKey;
    }

    public void setTokenEncryptionKey(String tokenEncryptionKey) {
        this.tokenEncryptionKey = tokenEncryptionKey;
    }

    public String getTokenEncryptionKid() {
        return tokenEncryptionKid;
    }

    public void setTokenEncryptionKid(String tokenEncryptionKid) {
        this.tokenEncryptionKid = tokenEncryptionKid;
    }

    public Duration getStateTtl() {
        return stateTtl;
    }

    public void setStateTtl(Duration stateTtl) {
        this.stateTtl = stateTtl;
    }

    public List<String> getAllowedRedirectOrigins() {
        return allowedRedirectOrigins;
    }

    public void setAllowedRedirectOrigins(List<String> allowedRedirectOrigins) {
        this.allowedRedirectOrigins = allowedRedirectOrigins == null ? new ArrayList<>() : allowedRedirectOrigins;
    }

    public void requireConfigured() {
        if (!enabled || isBlank(clientId) || isBlank(clientSecret) || isBlank(redirectUri)) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_NOT_CONFIGURED);
        }
    }

    public void requireGrantConfigured() {
        requireConfigured();
        if (isBlank(tokenEncryptionKey) || isBlank(tokenEncryptionKid)) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_NOT_CONFIGURED);
        }
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
