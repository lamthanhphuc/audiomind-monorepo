package com.example.processingservice.security;

import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Component
public class ApiKeyIntrospectionClient {

    private final RestTemplate restTemplate = new RestTemplate();

    @Value("${audiomind.user-api.base-url:http://localhost:8083}")
    private String userApiBaseUrl;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    @SuppressWarnings("unchecked")
    public Map<String, Object> introspect(String apiKey, String method, String path) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-Internal-Service-Token", internalServiceToken);
        Map<String, Object> body = Map.of(
                "apiKey", apiKey,
                "callerService", "processing-service",
                "method", method,
                "path", path
        );
        return restTemplate.postForObject(
                normalizeBaseUrl(userApiBaseUrl) + "/internal/api-keys/introspect",
                new HttpEntity<>(body, headers),
                Map.class
        );
    }

    private static String normalizeBaseUrl(String value) {
        if (value == null || value.isBlank()) {
            return "http://localhost:8083";
        }
        return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }
}
