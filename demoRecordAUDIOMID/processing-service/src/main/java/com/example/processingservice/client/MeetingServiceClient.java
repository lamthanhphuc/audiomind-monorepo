package com.example.processingservice.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.annotation.Qualifier;
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
import java.util.List;

@Service
public class MeetingServiceClient {

    private final RestTemplate restTemplate;

    public MeetingServiceClient(@Qualifier("meetingServiceRestTemplate") RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

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

    public List<Map<String, Object>> listMeetings(String traceId, String authorization) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        headers.add("x-trace-id", resolvedTraceId);
        headers.add("x-request-id", resolvedTraceId);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }

        ResponseEntity<List<Map<String, Object>>> response = restTemplate.exchange(
                meetingServiceUrl + "/meetings?sort=recent",
                HttpMethod.GET,
                new HttpEntity<>(headers),
                new ParameterizedTypeReference<>() {
                }
        );
        return response.getBody() == null ? List.of() : response.getBody();
    }

    public Map<String, Object> getSpeakerProfiles(Long meetingId, String traceId, String authorization) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        headers.add("x-trace-id", resolvedTraceId);
        headers.add("x-request-id", resolvedTraceId);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }

        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                meetingServiceUrl + "/meetings/" + meetingId + "/speakers",
                HttpMethod.GET,
                new HttpEntity<>(headers),
                new ParameterizedTypeReference<>() {
                }
        );
        Map<String, Object> body = response.getBody();
        if (body == null) {
            return Map.of("meetingId", meetingId, "profiles", List.of());
        }
        return body;
    }

    public Map<String, Object> getSubjectById(Long subjectId, String traceId, String authorization) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        headers.add("x-trace-id", resolvedTraceId);
        headers.add("x-request-id", resolvedTraceId);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }
        ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                meetingServiceUrl + "/subjects/" + subjectId,
                HttpMethod.GET,
                new HttpEntity<>(headers),
                new ParameterizedTypeReference<>() {
                }
        );
        Map<String, Object> body = response.getBody();
        if (body == null) {
            throw new IllegalStateException("Meeting service returned empty subject body for subjectId=" + subjectId);
        }
        return body;
    }

    /**
     * Fetch all meetings for a subject by paging until exhausted.
     */
    public List<Map<String, Object>> listAllSubjectMeetings(
            Long subjectId,
            String traceId,
            String authorization) {
        HttpHeaders headers = new HttpHeaders();
        String resolvedTraceId = resolveTraceId(traceId);
        headers.add("x-trace-id", resolvedTraceId);
        headers.add("x-request-id", resolvedTraceId);
        if (StringUtils.hasText(authorization)) {
            headers.add(HttpHeaders.AUTHORIZATION, authorization);
        }

        List<Map<String, Object>> all = new java.util.ArrayList<>();
        int page = 1;
        int pageSize = 100;
        while (true) {
            String url = meetingServiceUrl + "/subjects/" + subjectId
                    + "/meetings?page=" + page + "&pageSize=" + pageSize;
            ResponseEntity<Map<String, Object>> response = restTemplate.exchange(
                    url,
                    HttpMethod.GET,
                    new HttpEntity<>(headers),
                    new ParameterizedTypeReference<>() {
                    }
            );
            Map<String, Object> body = response.getBody();
            if (body == null) {
                break;
            }
            Object itemsObj = body.get("items");
            if (!(itemsObj instanceof List<?> items) || items.isEmpty()) {
                break;
            }
            for (Object item : items) {
                if (item instanceof Map<?, ?> map) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> cast = (Map<String, Object>) map;
                    all.add(cast);
                }
            }
            Object totalPagesObj = body.get("totalPages");
            int totalPages = totalPagesObj instanceof Number n ? n.intValue() : page;
            if (page >= totalPages) {
                break;
            }
            page++;
            if (page > 500) {
                break;
            }
        }
        return all;
    }

    private String resolveTraceId(String traceId) {
        if (traceId == null || traceId.isBlank()) {
            return UUID.randomUUID().toString();
        }
        return traceId;
    }
}
