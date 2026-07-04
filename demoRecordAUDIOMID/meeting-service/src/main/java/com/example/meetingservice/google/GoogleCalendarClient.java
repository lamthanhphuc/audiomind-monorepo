package com.example.meetingservice.google;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class GoogleCalendarClient {
    private static final Logger log = LoggerFactory.getLogger(GoogleCalendarClient.class);
    private static final DateTimeFormatter GOOGLE_LOCAL_DATE_TIME = DateTimeFormatter.ISO_LOCAL_DATE_TIME;
    private final GoogleCalendarProperties properties;
    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public GoogleCalendarClient(GoogleCalendarProperties properties) {
        this.properties = properties;
    }

    public CalendarEventResult createEvent(String accessToken, CalendarEventCommand command) {
        properties.requireConfigured();
        Map<String, Object> payload = new LinkedHashMap<>();
        String summary = command.audiomindPrefix()
                ? "Audiomind - " + command.title()
                : command.title();
        payload.put("summary", summary);
        payload.put("description", "Recording will be analyzed automatically by Audiomind.");
        String timeZone = command.timeZone();
        payload.put("start", Map.of(
                "dateTime", toGoogleLocalDateTime(command.startDateTime(), timeZone),
                "timeZone", timeZone));
        payload.put("end", Map.of(
                "dateTime", toGoogleLocalDateTime(command.endDateTime(), timeZone),
                "timeZone", timeZone));
        if (!command.attendees().isEmpty()) {
            payload.put("attendees", command.attendees().stream().map(email -> Map.of("email", email)).toList());
        }
        payload.put("conferenceData", Map.of(
                "createRequest", Map.of(
                        "requestId", command.requestId(),
                        "conferenceSolutionKey", Map.of("type", "hangoutsMeet"))));

        String sendUpdates = command.attendees().isEmpty() ? "none" : "all";
        URI uri = URI.create(properties.getCalendarApiBaseUrl()
                + "/calendars/primary/events?conferenceDataVersion=1&sendUpdates=" + sendUpdates);
        JsonNode response = sendJson("POST", uri, accessToken, payload);
        CalendarEventResult result = parse(response);
        if ("pending".equals(result.conferenceStatus()) && result.eventId() != null) {
            for (int attempt = 0; attempt < 2 && "pending".equals(result.conferenceStatus()); attempt++) {
                URI getUri = URI.create(properties.getCalendarApiBaseUrl()
                        + "/calendars/primary/events/"
                        + URLEncoder.encode(result.eventId(), StandardCharsets.UTF_8)
                        + "?conferenceDataVersion=1");
                result = parse(sendJson("GET", getUri, accessToken, null));
            }
        }
        return result;
    }

    public JsonNode listCalendars(String accessToken) {
        URI uri = URI.create(properties.getCalendarApiBaseUrl() + "/users/me/calendarList");
        return sendJson("GET", uri, accessToken, null);
    }

    public CalendarEventResult createQuickMeet(String accessToken, String summary) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("summary", summary == null || summary.isBlank() ? "Audiomind meeting" : summary.trim());
        payload.put("conferenceData", Map.of(
                "createRequest", Map.of(
                        "requestId", "audiomind-quick-" + System.currentTimeMillis(),
                        "conferenceSolutionKey", Map.of("type", "hangoutsMeet")
                )
        ));
        URI uri = URI.create(properties.getCalendarApiBaseUrl()
                + "/calendars/primary/events?conferenceDataVersion=1");
        return parse(sendJson("POST", uri, accessToken, payload));
    }

    public CalendarEventResult getEvent(String accessToken, String eventId) {
        URI uri = URI.create(properties.getCalendarApiBaseUrl()
                + "/calendars/primary/events/"
                + URLEncoder.encode(eventId, StandardCharsets.UTF_8)
                + "?conferenceDataVersion=1");
        return parse(sendJson("GET", uri, accessToken, null));
    }

    private JsonNode sendJson(String method, URI uri, String accessToken, Object payload) {
        try {
            HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofSeconds(20))
                    .header("Authorization", "Bearer " + accessToken)
                    .header("Accept", "application/json");
            if ("POST".equals(method)) {
                builder.header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(payload)));
            } else {
                builder.GET();
            }
            HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                return objectMapper.readTree(response.body());
            }
            if (response.statusCode() == 400) {
                log.warn(
                        "event=GOOGLE_CALENDAR_API_VALIDATION_FAILED status={} reasonPreview={}",
                        response.statusCode(),
                        sanitizeErrorPreview(response.body()));
                throw new GoogleCalendarException(GoogleCalendarError.GOOGLE_CALENDAR_VALIDATION_ERROR);
            }
            if (response.statusCode() == 401 || response.statusCode() == 403) {
                throwAuthFailure(response.statusCode(), response.body(), method, uri);
            }
            throw new GoogleCalendarException(
                    GoogleCalendarError.GOOGLE_CALENDAR_API_ERROR,
                    response.statusCode() >= 500,
                    null);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new GoogleCalendarException(GoogleCalendarError.GOOGLE_CALENDAR_API_ERROR, true, ex);
        } catch (IOException | IllegalArgumentException ex) {
            throw new GoogleCalendarException(GoogleCalendarError.GOOGLE_CALENDAR_API_ERROR, true, ex);
        }
    }

    private CalendarEventResult parse(JsonNode response) {
        String eventId = text(response, "id");
        String hangoutLink = text(response, "hangoutLink");
        JsonNode conference = response.path("conferenceData");
        String conferenceId = text(conference, "conferenceId");
        String conferenceStatus = conference.path("createRequest").path("status")
                .path("statusCode").asText(hangoutLink == null ? "pending" : "success");
        String meetUri = null;
        for (JsonNode entryPoint : conference.path("entryPoints")) {
            if ("video".equals(entryPoint.path("entryPointType").asText())) {
                meetUri = text(entryPoint, "uri");
                break;
            }
        }
        if (meetUri == null) {
            meetUri = hangoutLink;
        }
        String htmlLink = text(response, "htmlLink");
        return new CalendarEventResult(eventId, conferenceId, meetUri, hangoutLink, htmlLink, conferenceStatus);
    }

    private String text(JsonNode node, String field) {
        String value = node.path(field).asText("");
        return value.isBlank() ? null : value;
    }

    static String toGoogleLocalDateTime(String dateTime, String timeZone) {
        OffsetDateTime instant = OffsetDateTime.parse(dateTime);
        return instant.atZoneSameInstant(ZoneId.of(timeZone))
                .toLocalDateTime()
                .format(GOOGLE_LOCAL_DATE_TIME);
    }

    private void throwAuthFailure(int statusCode, String body, String method, URI uri) {
        String preview = sanitizeErrorPreview(body);
        log.warn(
                "event=GOOGLE_CALENDAR_API_FORBIDDEN status={} method={} path={} reasonPreview={}",
                statusCode,
                method,
                uri.getPath(),
                preview);
        throw new GoogleCalendarException(resolveAuthError(statusCode, body));
    }

    static GoogleCalendarError resolveAuthError(int statusCode, String body) {
        if (isInsufficientScopeResponse(body)) {
            return GoogleCalendarError.GOOGLE_SCOPE_MISSING;
        }
        if (statusCode == 401) {
            return GoogleCalendarError.GOOGLE_REFRESH_TOKEN_REVOKED;
        }
        return GoogleCalendarError.GOOGLE_CALENDAR_PERMISSION_DENIED;
    }

    static boolean isInsufficientScopeResponse(String body) {
        if (body == null || body.isBlank()) {
            return false;
        }
        String normalized = body.toLowerCase();
        return normalized.contains("insufficientpermissions")
                || normalized.contains("insufficient authentication scopes")
                || normalized.contains("access_not_configured")
                || normalized.contains("accessnotconfigured");
    }

    private String sanitizeErrorPreview(String body) {
        if (body == null || body.isBlank()) {
            return "empty";
        }
        String normalized = body.replaceAll("\\s+", " ").trim();
        return normalized.length() > 200 ? normalized.substring(0, 200) : normalized;
    }

    public record CalendarEventCommand(
            String title,
            String startDateTime,
            String endDateTime,
            String timeZone,
            List<String> attendees,
            String requestId,
            boolean audiomindPrefix) {
        public CalendarEventCommand(
                String title,
                String startDateTime,
                String endDateTime,
                String timeZone,
                List<String> attendees,
                String requestId) {
            this(title, startDateTime, endDateTime, timeZone, attendees, requestId, true);
        }

        public CalendarEventCommand {
            attendees = attendees == null ? new ArrayList<>() : List.copyOf(attendees);
        }
    }

    public record CalendarEventResult(
            String eventId,
            String conferenceId,
            String meetUri,
            String hangoutLink,
            String htmlLink,
            String conferenceStatus) {
    }
}
