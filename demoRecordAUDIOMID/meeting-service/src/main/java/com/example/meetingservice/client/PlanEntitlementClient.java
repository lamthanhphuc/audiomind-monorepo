package com.example.meetingservice.client;

import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class PlanEntitlementClient {

    private final RestTemplate restTemplate;

    @Value("${user.service.url:http://user-api:8083}")
    private String userServiceUrl;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    public void requireFeature(Long userId, String feature) {
        if (userId == null || userId <= 0 || !StringUtils.hasText(feature)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid feature authorization request");
        }
        if (!StringUtils.hasText(internalServiceToken)) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "PLAN_AUTHORIZATION_UNAVAILABLE");
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("X-Internal-Service-Token", internalServiceToken);
        Map<String, Object> body = Map.of("userId", userId, "feature", feature.trim());
        try {
            Map<?, ?> response = restTemplate.exchange(
                    normalizeBaseUrl(userServiceUrl) + "/internal/quota/authorize-feature",
                    HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    Map.class
            ).getBody();
            if (response == null || !(response.get("allowed") instanceof Boolean allowed)) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "PLAN_AUTHORIZATION_UNAVAILABLE");
            }
            if (!allowed) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "PLAN_FEATURE_REQUIRED");
            }
        } catch (ResponseStatusException ex) {
            throw ex;
        } catch (RestClientException ex) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "PLAN_AUTHORIZATION_UNAVAILABLE", ex);
        }
    }

    private static String normalizeBaseUrl(String value) {
        String normalized = value == null ? "" : value.trim();
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }
}
