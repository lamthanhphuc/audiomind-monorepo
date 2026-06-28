package com.example.meetingservice.google;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class InternalGoogleTokenClient {
    private final GoogleCalendarProperties properties;
    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    public InternalGoogleTokenClient(GoogleCalendarProperties properties) {
        this.properties = properties;
    }

    public String getAccessToken(Long userId, List<String> scopes) {
        properties.requireConfigured();
        try {
            String body = objectMapper.writeValueAsString(Map.of(
                    "callerService", "meeting-service",
                    "userId", userId,
                    "requiredScopes", scopes));
            HttpRequest request = HttpRequest.newBuilder(URI.create(
                            properties.getUserServiceUrl() + "/internal/google/access-token"))
                    .timeout(Duration.ofSeconds(15))
                    .header("Content-Type", "application/json")
                    .header("X-Internal-Service-Token", properties.getInternalServiceToken())
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                String token = objectMapper.readTree(response.body()).path("accessToken").asText("");
                if (!token.isBlank()) {
                    return token;
                }
            }
            throw mapError(response);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new GoogleCalendarException(
                    GoogleCalendarError.GOOGLE_INTERNAL_TOKEN_UNAVAILABLE, true, ex);
        } catch (IOException | IllegalArgumentException ex) {
            throw new GoogleCalendarException(
                    GoogleCalendarError.GOOGLE_INTERNAL_TOKEN_UNAVAILABLE, true, ex);
        }
    }

    private GoogleCalendarException mapError(HttpResponse<String> response) {
        try {
            JsonNode body = objectMapper.readTree(response.body());
            String code = body.path("error").asText(body.path("code").asText(""));
            if ("GOOGLE_SCOPE_MISSING".equals(code)) {
                JsonNode missingNode = body.path("details").path("missingScopes");
                List<String> missing = objectMapper.convertValue(
                        missingNode,
                        objectMapper.getTypeFactory().constructCollectionType(List.class, String.class));
                return new GoogleCalendarException(
                        GoogleCalendarError.GOOGLE_SCOPE_MISSING,
                        Map.of("missingScopes", missing));
            }
            if ("GOOGLE_REFRESH_TOKEN_REVOKED".equals(code)) {
                return new GoogleCalendarException(GoogleCalendarError.GOOGLE_REFRESH_TOKEN_REVOKED);
            }
        } catch (Exception ignored) {
            // Provider details are intentionally not propagated.
        }
        return new GoogleCalendarException(
                GoogleCalendarError.GOOGLE_INTERNAL_TOKEN_UNAVAILABLE,
                response.statusCode() >= 500,
                null);
    }
}
