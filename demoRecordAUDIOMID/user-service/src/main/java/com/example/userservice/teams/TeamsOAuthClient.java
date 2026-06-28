package com.example.userservice.teams;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class TeamsOAuthClient {

    private final TeamsOAuthProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    public TeamsOAuthClient(TeamsOAuthProperties properties) {
        this.properties = properties;
        this.objectMapper = new ObjectMapper().findAndRegisterModules();
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    public URI buildAuthorizeUri(String state) {
        String authorizeBase = "https://login.microsoftonline.com/"
                + encode(properties.getTenantId())
                + "/oauth2/v2.0/authorize";
        String scope = String.join(" ", TeamsScopes.LINK);
        String query = "client_id=" + encode(properties.getClientId())
                + "&response_type=code"
                + "&redirect_uri=" + encode(properties.getRedirectUri())
                + "&response_mode=query"
                + "&scope=" + encode(scope)
                + "&state=" + encode(state);
        return URI.create(authorizeBase + "?" + query);
    }

    public TeamsTokenResponse exchangeCode(String code) {
        properties.requireConfigured();
        String form = "grant_type=authorization_code"
                + "&code=" + encode(code)
                + "&redirect_uri=" + encode(properties.getRedirectUri())
                + "&client_id=" + encode(properties.getClientId())
                + "&client_secret=" + encode(properties.getClientSecret());
        return sendTokenRequest(form);
    }

    public TeamsTokenResponse refreshAccessToken(String refreshToken) {
        properties.requireGrantConfigured();
        String form = "grant_type=refresh_token"
                + "&refresh_token=" + encode(refreshToken)
                + "&client_id=" + encode(properties.getClientId())
                + "&client_secret=" + encode(properties.getClientSecret());
        return sendTokenRequest(form);
    }

    public TeamsUserProfile fetchCurrentUser(String accessToken) {
        HttpRequest request = HttpRequest.newBuilder(URI.create("https://graph.microsoft.com/v1.0/me"))
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer " + accessToken)
                .GET()
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR);
            }
            return objectMapper.readValue(response.body(), TeamsUserProfile.class);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR, ex);
        } catch (java.io.IOException ex) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    public List<Map<String, Object>> listRecordings(String accessToken, LocalDate from, LocalDate to) {
        String fromIso = from.atStartOfDay().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME) + "Z";
        String toIso = to.plusDays(1).atStartOfDay().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME) + "Z";
        String url = "https://graph.microsoft.com/v1.0/me/onlineMeetings/getAllRecordings"
                + "?$filter=createdDateTime ge " + fromIso + " and createdDateTime lt " + toIso;
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + accessToken)
                .GET()
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR);
            }
            JsonNode root = objectMapper.readTree(response.body());
            JsonNode values = root.get("value");
            List<Map<String, Object>> results = new ArrayList<>();
            if (values == null || !values.isArray()) {
                return results;
            }
            for (JsonNode recording : values) {
                String meetingId = text(recording.get("meetingId"));
                String recordingId = text(recording.get("id"));
                if (meetingId == null || recordingId == null) {
                    continue;
                }
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("uuid", meetingId + ":" + recordingId);
                item.put("meetingId", meetingId);
                item.put("recordingId", recordingId);
                item.put("topic", "Teams meeting " + meetingId.substring(0, Math.min(8, meetingId.length())));
                item.put("startTime", text(recording.get("createdDateTime")));
                item.put("duration", null);
                List<Map<String, Object>> files = new ArrayList<>();
                Map<String, Object> fileMap = new LinkedHashMap<>();
                fileMap.put("id", recordingId);
                fileMap.put("fileType", "MP4");
                fileMap.put("recordingStart", text(recording.get("createdDateTime")));
                fileMap.put("status", "completed");
                files.add(fileMap);
                item.put("recordingFiles", files);
                results.add(item);
            }
            return results;
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR, ex);
        } catch (java.io.IOException ex) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    public byte[] downloadRecording(String accessToken, String onlineMeetingId, String recordingId) {
        String url = "https://graph.microsoft.com/v1.0/me/onlineMeetings/"
                + encodePath(onlineMeetingId)
                + "/recordings/"
                + encodePath(recordingId)
                + "/content";
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofMinutes(10))
                .header("Authorization", "Bearer " + accessToken)
                .GET()
                .build();
        try {
            HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new TeamsOAuthException(TeamsOAuthError.TEAMS_RECORDING_IMPORT_FAILED);
            }
            return response.body();
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_RECORDING_IMPORT_FAILED, ex);
        } catch (java.io.IOException ex) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_RECORDING_IMPORT_FAILED, ex);
        }
    }

    private TeamsTokenResponse sendTokenRequest(String form) {
        URI tokenEndpoint = URI.create("https://login.microsoftonline.com/"
                + properties.getTenantId()
                + "/oauth2/v2.0/token");
        HttpRequest request = HttpRequest.newBuilder(tokenEndpoint)
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                boolean invalidGrant = response.body() != null && response.body().contains("invalid_grant");
                throw new TeamsOAuthException(invalidGrant
                        ? TeamsOAuthError.TEAMS_REFRESH_TOKEN_REVOKED
                        : TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR);
            }
            return objectMapper.readValue(response.body(), TeamsTokenResponse.class);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR, ex);
        } catch (java.io.IOException ex) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    private static String encode(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }

    private static String encodePath(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }

    private static String text(JsonNode node) {
        return node == null || node.isNull() ? null : node.asText();
    }
}
