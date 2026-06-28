package com.example.processingservice.client;

import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestTemplate;

@Service
@RequiredArgsConstructor
@Slf4j
public class JobNotificationClient {

    private final RestTemplate restTemplate;

    @Value("${audiomind.user-api.base-url:http://localhost:8083}")
    private String userApiBaseUrl;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    public void notifyJobStatus(
            Long userId,
            Long meetingId,
            String meetingTitle,
            String status,
            String error
    ) {
        if (!isConfigured()) {
            log.info(
                    "event=JOB_STATUS_NOTIFICATION_SKIPPED reason=user_service_not_configured meetingId={}",
                    meetingId
            );
            return;
        }

        Map<String, Object> body = Map.of(
                "userId", userId,
                "meetingId", meetingId,
                "meetingTitle", meetingTitle == null ? "" : meetingTitle,
                "status", status == null ? "" : status,
                "error", error == null ? "" : error
        );

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("X-Internal-Service-Token", internalServiceToken);

        try {
            ResponseEntity<Map> response = restTemplate.exchange(
                    normalizeBaseUrl(userApiBaseUrl) + "/internal/notifications/job-status",
                    HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    Map.class
            );
            if (!response.getStatusCode().is2xxSuccessful()) {
                log.warn(
                        "event=JOB_STATUS_NOTIFICATION_FAILED meetingId={} httpStatus={}",
                        meetingId,
                        response.getStatusCode().value()
                );
            }
        } catch (Exception ex) {
            log.warn(
                    "event=JOB_STATUS_NOTIFICATION_FAILED meetingId={} errorCode={}",
                    meetingId,
                    ex.getClass().getSimpleName()
            );
        }
    }

    private boolean isConfigured() {
        return StringUtils.hasText(userApiBaseUrl) && StringUtils.hasText(internalServiceToken);
    }

    private static String normalizeBaseUrl(String baseUrl) {
        if (baseUrl == null) {
            return "";
        }
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }
}
