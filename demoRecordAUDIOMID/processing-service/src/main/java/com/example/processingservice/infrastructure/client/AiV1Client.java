package com.example.processingservice.infrastructure.client;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

@Component
@RequiredArgsConstructor
public class AiV1Client {

    private final RestTemplate restTemplate;

    @Value("${audiomind.ai-api.base-url}")
    private String aiApiBaseUrl;

    public Map<String, Object> process(String meetingId) {
        Map<String, Object> body = new HashMap<>();
        body.put("meeting_id", meetingId);

        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
            aiApiBaseUrl + "/api/v1/process",
            HttpMethod.POST,
            new HttpEntity<>(body),
            new ParameterizedTypeReference<>() {
            }
        );

        Map<String, Object> responseBody = response.getBody();
        if (responseBody == null) {
            throw new IllegalStateException("AI v1 service returned empty body for meetingId=" + meetingId);
        }
        return responseBody;
    }
}
