package com.example.userservice.google;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class GoogleTokenResponseTest {

    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();

    @Test
    void deserializesGoogleTokenPayloadWithExtraFields() throws Exception {
        String payload = """
                {
                  "access_token": "ya29.access",
                  "expires_in": 3599,
                  "refresh_token": "1//refresh",
                  "scope": "openid email profile https://www.googleapis.com/auth/calendar.events",
                  "token_type": "Bearer",
                  "id_token": "eyJ.id",
                  "refresh_token_expires_in": 604799
                }
                """;

        GoogleTokenResponse response = objectMapper.readValue(payload, GoogleTokenResponse.class);

        assertThat(response.accessToken()).isEqualTo("ya29.access");
        assertThat(response.refreshToken()).isEqualTo("1//refresh");
        assertThat(response.idToken()).isEqualTo("eyJ.id");
        assertThat(response.scope()).contains("calendar.events");
    }
}
