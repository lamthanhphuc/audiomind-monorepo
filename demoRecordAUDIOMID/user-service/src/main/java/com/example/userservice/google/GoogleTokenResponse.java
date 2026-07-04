package com.example.userservice.google;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public record GoogleTokenResponse(
        @JsonProperty("access_token") String accessToken,
        @JsonProperty("expires_in") Long expiresIn,
        @JsonProperty("refresh_token") String refreshToken,
        @JsonProperty("id_token") String idToken,
        @JsonProperty("scope") String scope,
        @JsonProperty("token_type") String tokenType
) {
    public GoogleTokenResponse(
            String accessToken,
            Long expiresIn,
            String idToken,
            String scope,
            String tokenType) {
        this(accessToken, expiresIn, null, idToken, scope, tokenType);
    }
}
