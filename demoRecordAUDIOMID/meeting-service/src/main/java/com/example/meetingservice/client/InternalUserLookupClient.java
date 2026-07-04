package com.example.meetingservice.client;

import com.example.meetingservice.google.GoogleCalendarProperties;
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
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class InternalUserLookupClient {

    private final GoogleCalendarProperties properties;
    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    public InternalUserLookupClient(GoogleCalendarProperties properties) {
        this.properties = properties;
    }

    public Map<String, Object> lookupByEmail(String email) {
        return lookupByEmailOptional(email)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found for email"));
    }

    public Optional<Map<String, Object>> lookupByEmailOptional(String email) {
        properties.requireConfigured();
        try {
            String encodedEmail = URLEncoder.encode(email, StandardCharsets.UTF_8);
            HttpRequest request = HttpRequest.newBuilder(URI.create(
                            properties.getUserServiceUrl() + "/internal/users/lookup?email=" + encodedEmail))
                    .timeout(Duration.ofSeconds(15))
                    .header("X-Internal-Service-Token", properties.getInternalServiceToken())
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == HttpStatus.NOT_FOUND.value()) {
                return Optional.empty();
            }
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "User lookup failed");
            }
            return Optional.of(parseUserLookupBody(objectMapper.readTree(response.body())));
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "User lookup interrupted", ex);
        } catch (IOException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "User lookup failed", ex);
        }
    }

    public Optional<Map<String, Object>> lookupByUserIdOptional(Long userId) {
        if (userId == null) {
            return Optional.empty();
        }
        properties.requireConfigured();
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(
                            properties.getUserServiceUrl() + "/internal/users/by-id?userId=" + userId))
                    .timeout(Duration.ofSeconds(15))
                    .header("X-Internal-Service-Token", properties.getInternalServiceToken())
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() == HttpStatus.NOT_FOUND.value()) {
                return Optional.empty();
            }
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "User lookup failed");
            }
            return Optional.of(parseUserLookupBody(objectMapper.readTree(response.body())));
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "User lookup interrupted", ex);
        } catch (IOException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "User lookup failed", ex);
        }
    }

    private Map<String, Object> parseUserLookupBody(JsonNode body) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("userId", body.path("userId").asLong());
        result.put("email", body.path("email").asText(""));
        result.put("username", body.path("username").asText(""));
        return result;
    }
}
