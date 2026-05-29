package com.example.processingservice.client;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.retry.annotation.Backoff;
import org.springframework.retry.annotation.Retryable;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;
import org.springframework.util.StringUtils;

import java.util.Map;
import java.util.UUID;

@Service
@RequiredArgsConstructor
public class MeetingServiceClient {

    private final RestTemplate restTemplate;

    @Value("${meeting.service.url}")
    private String meetingServiceUrl;

        @Retryable(
            retryFor = Exception.class,
            maxAttempts = 3,
            backoff = @Backoff(delay = 1000, multiplier = 2)
        )
    public Map<String, Object> getMeetingById(Long meetingId, String traceId, String authorization) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        headers.add("x-trace-id", resolvedTraceId);
        headers.add("x-request-id", resolvedTraceId);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }

        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                meetingServiceUrl + "/meetings/" + meetingId,
            HttpMethod.GET,
            new HttpEntity<>(headers),
            new ParameterizedTypeReference<>() {
            }
        );

        Map<String, Object> body = response.getBody();
        if (body == null) {
            throw new IllegalStateException("Meeting service returned empty body for meetingId=" + meetingId);
        }
        return body;
    }

    @Retryable(
            retryFor = Exception.class,
            maxAttempts = 3,
            backoff = @Backoff(delay = 1000, multiplier = 2)
    )
    public Map<String, Object> updateMeetingStatus(Long meetingId, String status, String traceId, String authorization) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        headers.add("x-trace-id", resolvedTraceId);
        headers.add("x-request-id", resolvedTraceId);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }

        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                meetingServiceUrl + "/meetings/" + meetingId + "/status",
                HttpMethod.PATCH,
                new HttpEntity<>(Map.of("status", status), headers),
                new ParameterizedTypeReference<>() {
                }
        );

        Map<String, Object> body = response.getBody();
        if (body == null) {
            throw new IllegalStateException("Meeting service returned empty body while updating status for meetingId=" + meetingId);
        }
        return body;
    }

    private String resolveTraceId(String traceId) {
        if (traceId == null || traceId.isBlank()) {
            return UUID.randomUUID().toString();
        }
        return traceId;
    }
}
