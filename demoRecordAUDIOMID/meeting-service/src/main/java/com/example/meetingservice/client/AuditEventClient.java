package com.example.meetingservice.client;

import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestTemplate;

@Component
@RequiredArgsConstructor
@Slf4j
public class AuditEventClient {

    private final RestTemplate restTemplate;

    @Value("${audiomind.user-api.base-url:http://localhost:8083}")
    private String userApiBaseUrl;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    public void record(Long actorUserId, String eventType, String targetType, String targetId, String summary, Map<String, Object> metadata) {
        if (!StringUtils.hasText(internalServiceToken)) {
            log.warn("event=AUDIT_EVENT_SKIPPED reason=missing_internal_token eventType={}", eventType);
            return;
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.add("X-Internal-Service-Token", internalServiceToken);
            restTemplate.postForEntity(
                    normalizeBaseUrl(userApiBaseUrl) + "/internal/audit-events",
                    new HttpEntity<>(Map.of(
                            "actorUserId", actorUserId,
                            "eventType", eventType,
                            "targetType", targetType,
                            "targetId", targetId,
                            "summary", summary,
                            "metadata", metadata == null ? Map.of() : metadata
                    ), headers),
                    Map.class
            );
        } catch (Exception ex) {
            log.warn("event=AUDIT_EVENT_FAILED eventType={} errorCode={}", eventType, ex.getClass().getSimpleName());
        }
    }

    private static String normalizeBaseUrl(String baseUrl) {
        if (baseUrl == null) {
            return "";
        }
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }
}
