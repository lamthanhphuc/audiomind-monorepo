package com.example.userservice.notification.gmail;



import com.example.userservice.controller.dto.InternalGoogleAccessTokenResponse;

import com.example.userservice.notification.HumanReadableLabel;

import com.example.userservice.google.GoogleGrantService;

import com.example.userservice.google.GoogleOAuthError;

import com.example.userservice.google.GoogleOAuthException;

import com.example.userservice.google.GoogleScopes;

import java.util.List;

import java.util.Map;

import java.util.Optional;

import lombok.RequiredArgsConstructor;

import lombok.extern.slf4j.Slf4j;

import org.springframework.http.HttpEntity;

import org.springframework.http.HttpHeaders;

import org.springframework.http.HttpMethod;

import org.springframework.http.MediaType;

import org.springframework.http.ResponseEntity;

import org.springframework.stereotype.Service;

import org.springframework.web.client.HttpStatusCodeException;

import org.springframework.web.client.RestTemplate;



@Service

@RequiredArgsConstructor

@Slf4j

public class GmailSendService {



    private static final String GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

    private static final List<Integer> RETRY_BACKOFF_MS = List.of(1000, 2000, 4000);



    private final GoogleGrantService grantService;

    private final Rfc822MessageBuilder messageBuilder;

    private final RestTemplate restTemplate;



    public Optional<String> sendPlainText(Long userId, String to, String subject, String body, String replyTo) {
        return sendMultipart(userId, to, subject, body, null, replyTo);
    }

    public Optional<String> sendMultipart(
            Long userId,
            String to,
            String subject,
            String plainBody,
            String htmlBody,
            String replyTo
    ) {

        Optional<String> fromEmail = grantService.resolveGoogleProviderEmail(userId);

        if (fromEmail.isEmpty()) {

            log.warn("event=GMAIL_SEND_SKIPPED userId={} reason=missing_google_email", userId);

            return Optional.empty();

        }

        try {

            InternalGoogleAccessTokenResponse token = grantService.accessToken(

                    userId,

                    List.of(GoogleScopes.GMAIL_SEND)

            );

            String raw = messageBuilder.buildBase64UrlRaw(
                    fromEmail.get(),
                    resolveFromDisplayName(userId, fromEmail.get()),
                    to,
                    subject,
                    plainBody,
                    htmlBody,
                    replyTo
            );

            return sendWithRetry(userId, token.accessToken(), raw);

        } catch (GoogleOAuthException ex) {

            if (ex.error() == GoogleOAuthError.GOOGLE_SCOPE_MISSING

                    || ex.error() == GoogleOAuthError.GOOGLE_REFRESH_TOKEN_REVOKED) {

                log.warn("event=GMAIL_SEND_SKIPPED userId={} reason={}", userId, ex.error().name());

                return Optional.empty();

            }

            throw ex;

        }

    }

    private String resolveFromDisplayName(Long userId, String fromEmail) {
        return grantService.resolveGoogleDisplayName(userId)
                .map(HumanReadableLabel::sanitize)
                .filter(name -> !name.isBlank())
                .orElse(fromEmail);
    }

    @SuppressWarnings("unchecked")
    private Optional<String> sendWithRetry(Long userId, String accessToken, String raw) {

        HttpHeaders headers = new HttpHeaders();

        headers.setBearerAuth(accessToken);

        headers.setContentType(MediaType.APPLICATION_JSON);

        Map<String, Object> payload = Map.of("raw", raw);

        HttpEntity<Map<String, Object>> entity = new HttpEntity<>(payload, headers);



        int attempt = 0;

        while (true) {

            try {

                ResponseEntity<Map> response = restTemplate.exchange(

                        GMAIL_SEND_URL,

                        HttpMethod.POST,

                        entity,

                        Map.class

                );

                Map<String, Object> body = response.getBody();

                if (body == null || body.get("id") == null) {

                    return Optional.empty();

                }

                String messageId = String.valueOf(body.get("id"));

                verifySentLabel(userId, accessToken, messageId);

                return Optional.of(messageId);

            } catch (HttpStatusCodeException ex) {

                if (ex.getStatusCode().value() == 429 && attempt < RETRY_BACKOFF_MS.size()) {

                    log.warn("event=GMAIL_SEND_RATE_LIMITED userId={} attempt={}", userId, attempt + 1);

                    sleep(RETRY_BACKOFF_MS.get(attempt));

                    attempt++;

                    continue;

                }

                log.warn(

                        "event=GMAIL_SEND_FAILED userId={} httpStatus={}",

                        userId,

                        ex.getStatusCode().value()

                );

                return Optional.empty();

            } catch (RuntimeException ex) {

                log.warn(

                        "event=GMAIL_SEND_FAILED userId={} errorCode={}",

                        userId,

                        ex.getClass().getSimpleName()

                );

                return Optional.empty();

            }

        }

    }



    @SuppressWarnings("unchecked")

    private void verifySentLabel(Long userId, String accessToken, String messageId) {

        try {

            HttpHeaders headers = new HttpHeaders();

            headers.setBearerAuth(accessToken);

            String url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/"

                    + messageId

                    + "?format=metadata";

            ResponseEntity<Map> response = restTemplate.exchange(

                    url,

                    HttpMethod.GET,

                    new HttpEntity<>(headers),

                    Map.class

            );

            Map<String, Object> body = response.getBody();

            Object labels = body == null ? null : body.get("labelIds");

            boolean hasSentLabel = labels instanceof List<?> labelList && labelList.contains("SENT");

            log.info(

                    "event=GMAIL_SEND_VERIFIED userId={} messageId={} hasSentLabel={}",

                    userId,

                    messageId,

                    hasSentLabel

            );

        } catch (HttpStatusCodeException ex) {

            if (ex.getStatusCode().value() == 403) {

                log.info(

                        "event=GMAIL_SEND_VERIFY_SKIPPED userId={} messageId={} reason=metadata_scope_missing",

                        userId,

                        messageId

                );

                return;

            }

            log.warn(

                    "event=GMAIL_SEND_VERIFY_FAILED userId={} messageId={} httpStatus={}",

                    userId,

                    messageId,

                    ex.getStatusCode().value()

            );

        } catch (RuntimeException ex) {

            log.warn(

                    "event=GMAIL_SEND_VERIFY_FAILED userId={} messageId={} errorCode={}",

                    userId,

                    messageId,

                    ex.getClass().getSimpleName()

            );

        }

    }



    private void sleep(int millis) {

        try {

            Thread.sleep(millis);

        } catch (InterruptedException ex) {

            Thread.currentThread().interrupt();

        }

    }

}


