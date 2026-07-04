package com.example.meetingservice.client;



import com.example.meetingservice.google.GoogleCalendarProperties;

import com.fasterxml.jackson.databind.JsonNode;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;

import java.net.URI;

import java.net.http.HttpClient;

import java.net.http.HttpRequest;

import java.net.http.HttpResponse;

import java.nio.charset.StandardCharsets;

import java.time.Duration;

import java.util.ArrayList;

import java.util.List;

import java.util.Map;

import lombok.extern.slf4j.Slf4j;

import org.springframework.stereotype.Component;



@Component

@Slf4j

public class ShareNotificationClient {



    private final GoogleCalendarProperties properties;

    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();

    private final HttpClient httpClient = HttpClient.newBuilder()

            .connectTimeout(Duration.ofSeconds(5))

            .build();



    public ShareNotificationClient(GoogleCalendarProperties properties) {

        this.properties = properties;

    }



    public ShareNotificationResponse notifyPendingMeetingShareInvite(

            String inviteeEmail,

            Long inviterUserId,

            Long meetingId,

            String meetingTitle,

            String role

    ) {

        if (!isUserServiceConfigured()) {

            log.info(

                    "event=MEETING_SHARE_PENDING_NOTIFICATION_SKIPPED reason=user_service_not_configured meetingId={}",

                    meetingId

            );

            return ShareNotificationResponse.skipped();

        }

        try {

            Map<String, Object> body = Map.of(

                    "inviteeEmail", inviteeEmail,

                    "inviterUserId", inviterUserId,

                    "meetingId", meetingId,

                    "meetingTitle", meetingTitle == null ? "" : meetingTitle,

                    "role", role == null ? "VIEWER" : role

            );

            HttpRequest request = HttpRequest.newBuilder(URI.create(

                            properties.getUserServiceUrl() + "/internal/notifications/meeting-share-pending"))

                    .timeout(Duration.ofSeconds(15))

                    .header("Content-Type", "application/json")

                    .header("X-Internal-Service-Token", properties.getInternalServiceToken())

                    .POST(HttpRequest.BodyPublishers.ofString(

                            objectMapper.writeValueAsString(body),

                            StandardCharsets.UTF_8))

                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() < 200 || response.statusCode() >= 300) {

                log.warn(

                        "event=MEETING_SHARE_PENDING_NOTIFICATION_FAILED meetingId={} httpStatus={}",

                        meetingId,

                        response.statusCode()

                );

                return ShareNotificationResponse.skipped();

            }

            return parseEmailResponse(response.body());

        } catch (InterruptedException ex) {

            Thread.currentThread().interrupt();

            log.warn("event=MEETING_SHARE_PENDING_NOTIFICATION_INTERRUPTED meetingId={}", meetingId);

            return ShareNotificationResponse.skipped();

        } catch (IOException ex) {

            log.warn(

                    "event=MEETING_SHARE_PENDING_NOTIFICATION_FAILED meetingId={} errorCode={}",

                    meetingId,

                    ex.getClass().getSimpleName()

            );

            return ShareNotificationResponse.skipped();

        }

    }



    public void notifyMeetingShare(

            Long inviteeUserId,

            Long inviterUserId,

            Long meetingId,

            String meetingTitle,

            String role

    ) {

        if (!isUserServiceConfigured()) {

            log.info(

                    "event=MEETING_SHARE_NOTIFICATION_SKIPPED reason=user_service_not_configured meetingId={}",

                    meetingId

            );

            return;

        }

        try {

            Map<String, Object> body = Map.of(

                    "inviteeUserId", inviteeUserId,

                    "inviterUserId", inviterUserId,

                    "meetingId", meetingId,

                    "meetingTitle", meetingTitle == null ? "" : meetingTitle,

                    "role", role == null ? "VIEWER" : role

            );

            HttpRequest request = HttpRequest.newBuilder(URI.create(

                            properties.getUserServiceUrl() + "/internal/notifications/meeting-share"))

                    .timeout(Duration.ofSeconds(15))

                    .header("Content-Type", "application/json")

                    .header("X-Internal-Service-Token", properties.getInternalServiceToken())

                    .POST(HttpRequest.BodyPublishers.ofString(

                            objectMapper.writeValueAsString(body),

                            StandardCharsets.UTF_8))

                    .build();

            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() < 200 || response.statusCode() >= 300) {

                log.warn(

                        "event=MEETING_SHARE_NOTIFICATION_FAILED meetingId={} httpStatus={}",

                        meetingId,

                        response.statusCode()

                );

            }

        } catch (InterruptedException ex) {

            Thread.currentThread().interrupt();

            log.warn("event=MEETING_SHARE_NOTIFICATION_INTERRUPTED meetingId={}", meetingId);

        } catch (IOException ex) {

            log.warn(

                    "event=MEETING_SHARE_NOTIFICATION_FAILED meetingId={} errorCode={}",

                    meetingId,

                    ex.getClass().getSimpleName()

            );

        }

    }



    private ShareNotificationResponse parseEmailResponse(String body) throws IOException {

        JsonNode payload = objectMapper.readTree(body);

        boolean sent = "sent".equalsIgnoreCase(payload.path("status").asText());

        String channel = payload.path("channel").asText("NONE");

        boolean requiresGmailScope = payload.path("requiresGmailScope").asBoolean(false);
        String emailFrom = payload.path("emailFrom").asText(null);
        if (emailFrom != null && emailFrom.isBlank()) {
            emailFrom = null;
        }

        List<String> missingScopes = new ArrayList<>();

        JsonNode missingNode = payload.path("missingScopes");

        if (missingNode.isArray()) {

            missingNode.forEach(node -> missingScopes.add(node.asText()));

        }

        return new ShareNotificationResponse(sent, channel, requiresGmailScope, List.copyOf(missingScopes), emailFrom);

    }



    private boolean isUserServiceConfigured() {

        return properties.getUserServiceUrl() != null

                && !properties.getUserServiceUrl().isBlank()

                && properties.getInternalServiceToken() != null

                && !properties.getInternalServiceToken().isBlank();

    }

}


