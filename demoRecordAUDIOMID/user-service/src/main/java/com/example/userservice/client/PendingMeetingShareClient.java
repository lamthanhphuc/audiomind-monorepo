package com.example.userservice.client;

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
public class PendingMeetingShareClient {

    private final RestTemplate restTemplate;

    @Value("${audiomind.meeting-api.base-url:http://localhost:8081}")
    private String meetingApiBaseUrl;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    public void acceptPendingInvites(Long userId, String email) {
        if (userId == null || !StringUtils.hasText(email)) {
            return;
        }
        if (!StringUtils.hasText(internalServiceToken)) {
            log.warn(
                    "event=MEETING_SHARE_PENDING_ACCEPT_SKIPPED reason=missing_internal_token userId={}",
                    userId);
            return;
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.add("X-Internal-Service-Token", internalServiceToken);
            HttpEntity<Map<String, Object>> entity = new HttpEntity<>(
                    Map.of("userId", userId, "email", email.trim()),
                    headers
            );
            restTemplate.postForEntity(
                    normalizeBaseUrl(meetingApiBaseUrl) + "/internal/meeting-shares/accept-pending",
                    entity,
                    Map.class
            );
        } catch (Exception ex) {
            log.warn(
                    "event=MEETING_SHARE_PENDING_ACCEPT_FAILED userId={} errorCode={}",
                    userId,
                    ex.getClass().getSimpleName()
            );
        }
    }

    private static String normalizeBaseUrl(String baseUrl) {
        if (baseUrl == null) {
            return "";
        }
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }
}
