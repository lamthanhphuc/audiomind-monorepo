package com.example.userservice.notification.gmail;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.controller.dto.InternalGoogleAccessTokenResponse;
import com.example.userservice.google.GoogleGrantService;
import com.example.userservice.google.GoogleOAuthError;
import com.example.userservice.google.GoogleOAuthException;
import com.example.userservice.google.GoogleScopes;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

@ExtendWith(MockitoExtension.class)
class GmailSendServiceTest {

    @Mock
    private GoogleGrantService grantService;
    @Mock
    private Rfc822MessageBuilder messageBuilder;
    @Mock
    private RestTemplate restTemplate;

    private GmailSendService service;

    @BeforeEach
    void setUp() {
        service = new GmailSendService(grantService, messageBuilder, restTemplate);
    }

    @Test
    void sendPlainText_returnsMessageIdOnSuccess() {
        when(grantService.resolveGoogleProviderEmail(5L)).thenReturn(Optional.of("sender@gmail.com"));
        when(grantService.resolveGoogleDisplayName(5L)).thenReturn(Optional.of("Sender Name"));
        when(grantService.accessToken(5L, List.of(GoogleScopes.GMAIL_SEND)))
                .thenReturn(new InternalGoogleAccessTokenResponse("access-token", 3600));
        when(messageBuilder.buildBase64UrlRaw(
                "sender@gmail.com", "Sender Name", "guest@example.com", "Subject", "Body", null, "reply@example.com"))
                .thenReturn("raw-message");
        when(restTemplate.exchange(
                eq("https://gmail.googleapis.com/gmail/v1/users/me/messages/send"),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                eq(Map.class)
        )).thenReturn(ResponseEntity.ok(Map.of("id", "msg-123")));

        Optional<String> result = service.sendPlainText(
                5L, "guest@example.com", "Subject", "Body", "reply@example.com");

        assertThat(result).contains("msg-123");
    }

    @Test
    void sendPlainText_returnsEmptyWhenScopeMissing() {
        when(grantService.resolveGoogleProviderEmail(5L)).thenReturn(Optional.of("sender@gmail.com"));
        when(grantService.accessToken(5L, List.of(GoogleScopes.GMAIL_SEND)))
                .thenThrow(new GoogleOAuthException(GoogleOAuthError.GOOGLE_SCOPE_MISSING));

        Optional<String> result = service.sendPlainText(5L, "guest@example.com", "Subject", "Body", null);

        assertThat(result).isEmpty();
    }

    @Test
    void sendPlainText_returnsEmptyWhenGoogleEmailMissing() {
        when(grantService.resolveGoogleProviderEmail(5L)).thenReturn(Optional.empty());

        Optional<String> result = service.sendPlainText(5L, "guest@example.com", "Subject", "Body", null);

        assertThat(result).isEmpty();
    }

    @Test
    void sendPlainText_retriesOn429() {
        when(grantService.resolveGoogleProviderEmail(5L)).thenReturn(Optional.of("sender@gmail.com"));
        when(grantService.resolveGoogleDisplayName(5L)).thenReturn(Optional.empty());
        when(grantService.accessToken(5L, List.of(GoogleScopes.GMAIL_SEND)))
                .thenReturn(new InternalGoogleAccessTokenResponse("access-token", 3600));
        when(messageBuilder.buildBase64UrlRaw(
                "sender@gmail.com", "sender@gmail.com", "guest@example.com", "Subject", "Body", null, null))
                .thenReturn("raw-message");
        when(restTemplate.exchange(
                eq("https://gmail.googleapis.com/gmail/v1/users/me/messages/send"),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                eq(Map.class)
        ))
                .thenThrow(HttpClientErrorException.create(
                        HttpStatus.TOO_MANY_REQUESTS,
                        "rate limited",
                        null,
                        null,
                        null
                ))
                .thenReturn(ResponseEntity.ok(Map.of("id", "msg-456")));

        Optional<String> result = service.sendPlainText(5L, "guest@example.com", "Subject", "Body", null);

        assertThat(result).contains("msg-456");
        verify(restTemplate, times(2)).exchange(
                eq("https://gmail.googleapis.com/gmail/v1/users/me/messages/send"),
                eq(HttpMethod.POST),
                any(HttpEntity.class),
                eq(Map.class)
        );
    }
}
