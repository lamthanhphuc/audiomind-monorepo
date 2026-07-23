package com.example.meetingservice.client;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

@Component
public class WorkspaceAccessClient {

    private final RestTemplate restTemplate = new RestTemplate();

    @Value("${audiomind.user-api.base-url:${user.service.url:http://localhost:8083}}")
    private String userApiBaseUrl;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    @SuppressWarnings("unchecked")
    public boolean canAccessOwnerMeetings(Long userId, Long ownerUserId) {
        if (userId == null || ownerUserId == null || Objects.equals(userId, ownerUserId)) {
            return Objects.equals(userId, ownerUserId);
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.set("X-Internal-Service-Token", internalServiceToken);
            ResponseEntity<Map> response = restTemplate.exchange(
                    normalizeBaseUrl(userApiBaseUrl) + "/internal/workspaces/members?userId=" + userId,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    Map.class
            );
            Object items = response.getBody() == null ? null : response.getBody().get("items");
            if (!(items instanceof List<?> list)) {
                return false;
            }
            return list.stream()
                    .filter(Map.class::isInstance)
                    .map(Map.class::cast)
                    .anyMatch(member -> Objects.equals(String.valueOf(ownerUserId), String.valueOf(member.get("userId"))));
        } catch (RestClientException ex) {
            return false;
        }
    }

    private static String normalizeBaseUrl(String value) {
        if (value == null || value.isBlank()) {
            return "http://localhost:8083";
        }
        return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }
}
