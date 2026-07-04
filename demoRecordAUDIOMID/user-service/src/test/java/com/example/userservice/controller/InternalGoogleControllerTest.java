package com.example.userservice.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.controller.dto.InternalGoogleAccessTokenRequest;
import com.example.userservice.controller.dto.InternalGoogleAccessTokenResponse;
import com.example.userservice.google.GoogleGrantService;
import com.example.userservice.google.GoogleOAuthError;
import com.example.userservice.google.GoogleOAuthException;
import com.example.userservice.google.GoogleOAuthProperties;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class InternalGoogleControllerTest {

    @Mock
    private GoogleGrantService grantService;

    private GoogleOAuthProperties properties;
    private InternalGoogleController controller;

    @BeforeEach
    void setUp() {
        properties = new GoogleOAuthProperties();
        properties.setEnabled(true);
        properties.setClientId("client-id");
        properties.setClientSecret("client-secret");
        properties.setRedirectUri("http://localhost/callback");
        properties.setFrontendBaseUrl("http://localhost:8080");
        properties.setLinkRedirectUri("http://localhost/link");
        properties.setTokenEncryptionKey("0123456789abcdef0123456789abcdef");
        properties.setTokenEncryptionKid("v1");
        properties.setInternalServiceToken("internal-token");
        controller = new InternalGoogleController(grantService, properties);
    }

    @Test
    void rejectsMissingInternalToken() {
        InternalGoogleAccessTokenRequest request = new InternalGoogleAccessTokenRequest(
                "meeting-service",
                9L,
                List.of("https://www.googleapis.com/auth/calendar.events")
        );

        assertThatThrownBy(() -> controller.accessToken(null, request))
                .isInstanceOf(GoogleOAuthException.class)
                .extracting(ex -> ((GoogleOAuthException) ex).error())
                .isEqualTo(GoogleOAuthError.GOOGLE_INTERNAL_CALL_FORBIDDEN);

        verify(grantService, never()).accessToken(any(), any());
    }

    @Test
    void rejectsUnknownCallerService() {
        InternalGoogleAccessTokenRequest request = new InternalGoogleAccessTokenRequest(
                "unknown-service",
                9L,
                List.of("https://www.googleapis.com/auth/calendar.events")
        );

        assertThatThrownBy(() -> controller.accessToken("internal-token", request))
                .isInstanceOf(GoogleOAuthException.class);
    }

    @Test
    void returnsAccessTokenForAllowedCaller() {
        InternalGoogleAccessTokenRequest request = new InternalGoogleAccessTokenRequest(
                "meeting-service",
                9L,
                List.of("https://www.googleapis.com/auth/calendar.events")
        );
        when(grantService.accessToken(9L, request.requiredScopes()))
                .thenReturn(new InternalGoogleAccessTokenResponse("token-1", 3600L));

        InternalGoogleAccessTokenResponse response = controller.accessToken("internal-token", request);

        assertThat(response.accessToken()).isEqualTo("token-1");
    }
}
