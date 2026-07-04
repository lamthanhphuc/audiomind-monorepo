package com.example.userservice.client;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestTemplate;

@Service
@RequiredArgsConstructor
@Slf4j
public class RestProcessingClient implements ProcessingClient {

    private final RestTemplate restTemplate;

    @Value("${audiomind.processing-api.base-url:http://localhost:8082}")
    private String processingApiBaseUrl;

    @Override
    public Map<String, Object> getUserJobs(Long userId, String authorization) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("source", "processing-service");
        response.put("userId", userId);
        if (!StringUtils.hasText(authorization)) {
            response.put("jobs", List.of());
            response.put("error", "missing_authorization");
            return response;
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
            ResponseEntity<Map<String, Object>> entity = restTemplate.exchange(
                    normalizeBaseUrl(processingApiBaseUrl) + "/processing/me/jobs",
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    new ParameterizedTypeReference<>() {
                    }
            );
            Map<String, Object> body = entity.getBody();
            Object jobs = body == null ? List.of() : body.getOrDefault("jobs", List.of());
            response.put("jobs", jobs);
            if (body != null && body.get("activeCount") != null) {
                response.put("activeCount", body.get("activeCount"));
            }
        } catch (Exception ex) {
            log.warn(
                    "event=PROCESSING_CLIENT_LIST_FAILED userId={} errorCode={}",
                    userId,
                    ex.getClass().getSimpleName()
            );
            response.put("jobs", List.of());
            response.put("error", "upstream_unavailable");
        }
        return response;
    }

    @Override
    public Map<String, Object> startProcessing(Long meetingId, String language, String authorization) {
        if (!StringUtils.hasText(authorization)) {
            throw new IllegalArgumentException("missing_authorization");
        }
        HttpHeaders headers = new HttpHeaders();
        headers.add(HttpHeaders.AUTHORIZATION, authorization);
        String url = normalizeBaseUrl(processingApiBaseUrl)
                + "/processing/start/" + meetingId
                + (StringUtils.hasText(language) ? "?language=" + language : "");
        ResponseEntity<Map<String, Object>> entity = restTemplate.exchange(
                url,
                HttpMethod.POST,
                new HttpEntity<>(headers),
                new ParameterizedTypeReference<>() {
                }
        );
        return entity.getBody() == null ? Map.of() : entity.getBody();
    }

    private static String normalizeBaseUrl(String baseUrl) {
        if (baseUrl == null) {
            return "";
        }
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }
}
