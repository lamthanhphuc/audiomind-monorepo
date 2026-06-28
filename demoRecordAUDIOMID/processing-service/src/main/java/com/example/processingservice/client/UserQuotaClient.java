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
public class UserQuotaClient {

    private final RestTemplate restTemplate;

    @Value("${audiomind.user-api.base-url:http://localhost:8083}")
    private String userApiBaseUrl;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    @Value("${app.internal.quota-fail-open:true}")
    private boolean quotaFailOpen;

    public QuotaConsumeResult consume(Long userId, long sttSecondsDelta, long geminiCharsDelta) {
        if (!StringUtils.hasText(internalServiceToken)) {
            if (quotaFailOpen) {
                log.warn("event=QUOTA_CLIENT_SKIPPED reason=missing_internal_token userId={}", userId);
                return new QuotaConsumeResult(true, null, null);
            }
            log.error("event=QUOTA_CLIENT_DENIED reason=missing_internal_token userId={}", userId);
            return new QuotaConsumeResult(false, null, "QUOTA_CLIENT_UNCONFIGURED");
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("X-Internal-Service-Token", internalServiceToken);

        Map<String, Object> body = Map.of(
                "userId", userId,
                "sttSecondsDelta", Math.max(0, sttSecondsDelta),
                "geminiCharsDelta", Math.max(0, geminiCharsDelta)
        );

        try {
            ResponseEntity<Map> response = restTemplate.exchange(
                    normalizeBaseUrl(userApiBaseUrl) + "/internal/quota/consume",
                    HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    Map.class
            );
            Map<?, ?> payload = response.getBody();
            if (payload == null) {
                if (quotaFailOpen) {
                    return new QuotaConsumeResult(true, null, null);
                }
                return new QuotaConsumeResult(false, null, "QUOTA_EMPTY_RESPONSE");
            }
            Object allowed = payload.get("allowed");
            boolean isAllowed = allowed instanceof Boolean b ? b : !quotaFailOpen;
            return new QuotaConsumeResult(isAllowed, payload, null);
        } catch (Exception ex) {
            if (quotaFailOpen) {
                log.warn("event=QUOTA_CLIENT_FAIL_OPEN userId={} message={}", userId, ex.getMessage());
                return new QuotaConsumeResult(true, null, null);
            }
            log.error("event=QUOTA_CLIENT_ERROR userId={} message={}", userId, ex.getMessage());
            return new QuotaConsumeResult(false, null, "QUOTA_CLIENT_ERROR");
        }
    }

    private static String normalizeBaseUrl(String baseUrl) {
        if (baseUrl == null) {
            return "";
        }
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }

    public record QuotaConsumeResult(boolean allowed, Map<?, ?> details, String error) {
    }
}
