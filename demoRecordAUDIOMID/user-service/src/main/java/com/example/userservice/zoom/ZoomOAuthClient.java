package com.example.userservice.zoom;

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
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

@Component
public class ZoomOAuthClient {

    private static final URI TOKEN_ENDPOINT = URI.create("https://zoom.us/oauth/token");
    private static final URI USER_ME_ENDPOINT = URI.create("https://api.zoom.us/v2/users/me");

    private final ZoomOAuthProperties properties;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    public ZoomOAuthClient(ZoomOAuthProperties properties) {
        this.properties = properties;
        this.objectMapper = new ObjectMapper().findAndRegisterModules();
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
    }

    public ZoomTokenResponse exchangeCode(String code) {
        properties.requireConfigured();
        String form = "grant_type=authorization_code"
                + "&code=" + encode(code)
                + "&redirect_uri=" + encode(properties.getRedirectUri());
        return sendTokenRequest(form);
    }

    public ZoomTokenResponse refreshAccessToken(String refreshToken) {
        properties.requireGrantConfigured();
        String form = "grant_type=refresh_token"
                + "&refresh_token=" + encode(refreshToken);
        return sendTokenRequest(form);
    }

    public ZoomUserProfile fetchCurrentUser(String accessToken) {
        HttpRequest request = HttpRequest.newBuilder(USER_ME_ENDPOINT)
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer " + accessToken)
                .GET()
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR);
            }
            return objectMapper.readValue(response.body(), ZoomUserProfile.class);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR, ex);
        } catch (java.io.IOException ex) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    public List<Map<String, Object>> listRecordings(String accessToken, LocalDate from, LocalDate to) {
        String url = "https://api.zoom.us/v2/users/me/recordings?from=" + from + "&to=" + to + "&page_size=30";
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + accessToken)
                .GET()
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR);
            }
            JsonNode root = objectMapper.readTree(response.body());
            JsonNode meetings = root.get("meetings");
            List<Map<String, Object>> results = new ArrayList<>();
            if (meetings == null || !meetings.isArray()) {
                return results;
            }
            for (JsonNode meeting : meetings) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("uuid", text(meeting.get("uuid")));
                item.put("id", meeting.get("id") == null ? null : meeting.get("id").asLong());
                item.put("topic", text(meeting.get("topic")));
                item.put("startTime", text(meeting.get("start_time")));
                item.put("duration", meeting.get("duration") == null ? null : meeting.get("duration").asInt());
                List<Map<String, Object>> files = new ArrayList<>();
                JsonNode recordingFiles = meeting.get("recording_files");
                if (recordingFiles != null && recordingFiles.isArray()) {
                    for (JsonNode file : recordingFiles) {
                        Map<String, Object> fileMap = new LinkedHashMap<>();
                        fileMap.put("id", text(file.get("id")));
                        fileMap.put("fileType", text(file.get("file_type")));
                        fileMap.put("fileSize", file.get("file_size") == null ? null : file.get("file_size").asLong());
                        fileMap.put("recordingStart", text(file.get("recording_start")));
                        fileMap.put("downloadUrl", text(file.get("download_url")));
                        fileMap.put("status", text(file.get("status")));
                        files.add(fileMap);
                    }
                }
                item.put("recordingFiles", files);
                results.add(item);
            }
            return results;
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR, ex);
        } catch (java.io.IOException ex) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    public byte[] downloadRecording(String accessToken, String downloadUrl) {
        if (downloadUrl == null || downloadUrl.isBlank()) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_RECORDING_NOT_FOUND);
        }
        HttpRequest request = HttpRequest.newBuilder(URI.create(downloadUrl))
                .timeout(Duration.ofMinutes(5))
                .header("Authorization", "Bearer " + accessToken)
                .GET()
                .build();
        try {
            HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new ZoomOAuthException(ZoomOAuthError.ZOOM_RECORDING_IMPORT_FAILED);
            }
            return response.body();
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_RECORDING_IMPORT_FAILED, ex);
        } catch (java.io.IOException ex) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_RECORDING_IMPORT_FAILED, ex);
        }
    }

    private ZoomTokenResponse sendTokenRequest(String form) {
        String credentials = properties.getClientId() + ":" + properties.getClientSecret();
        String basic = Base64.getEncoder().encodeToString(credentials.getBytes(StandardCharsets.UTF_8));
        HttpRequest request = HttpRequest.newBuilder(TOKEN_ENDPOINT)
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Basic " + basic)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form))
                .build();
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                boolean invalidGrant = response.body() != null && response.body().contains("invalid_grant");
                throw new ZoomOAuthException(invalidGrant
                        ? ZoomOAuthError.ZOOM_REFRESH_TOKEN_REVOKED
                        : ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR);
            }
            return objectMapper.readValue(response.body(), ZoomTokenResponse.class);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR, ex);
        } catch (java.io.IOException ex) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR, ex);
        }
    }

    private static String encode(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }

    private static String text(JsonNode node) {
        return node == null || node.isNull() ? null : node.asText();
    }
}
