package com.example.processingservice.client;

import java.util.HashMap;
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
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

@Service
@RequiredArgsConstructor
@Slf4j
public class UserQuotaClient {

    private static final int MAX_TRANSPORT_ATTEMPTS = 3;
    private static final long RETRY_SLEEP_MS = 50L;

    private final RestTemplate restTemplate;

    @Value("${audiomind.user-api.base-url:http://localhost:8083}")
    private String userApiBaseUrl;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    @Value("${app.internal.quota-fail-open:true}")
    private boolean quotaFailOpen;

    public enum QuotaConsumeStatus {
        ALLOWED,
        DENIED,
        UNKNOWN
    }

    public record QuotaConsumeResult(
            QuotaConsumeStatus status,
            String idempotencyKey,
            String quotaType,
            Map<?, ?> details,
            String errorCode,
            boolean retryable
    ) {
        /** Backward-compatible: true only when status is ALLOWED. */
        public boolean allowed() {
            return status == QuotaConsumeStatus.ALLOWED;
        }

        public static QuotaConsumeResult allowed(
                String idempotencyKey, String quotaType, Map<?, ?> details) {
            return new QuotaConsumeResult(
                    QuotaConsumeStatus.ALLOWED, idempotencyKey, quotaType, details, null, false);
        }

        public static QuotaConsumeResult denied(
                String idempotencyKey, String quotaType, Map<?, ?> details, String errorCode) {
            return new QuotaConsumeResult(
                    QuotaConsumeStatus.DENIED, idempotencyKey, quotaType, details, errorCode, false);
        }

        public static QuotaConsumeResult unknown(
                String idempotencyKey, String quotaType, String errorCode) {
            return unknown(idempotencyKey, quotaType, errorCode, true);
        }

        public static QuotaConsumeResult unknown(
                String idempotencyKey, String quotaType, String errorCode, boolean retryable) {
            return new QuotaConsumeResult(
                    QuotaConsumeStatus.UNKNOWN,
                    idempotencyKey,
                    quotaType,
                    null,
                    errorCode,
                    retryable);
        }
    }

    /**
     * Legacy STT / realtime path. Fail-open may return ALLOWED when quotaFailOpen is true.
     */
    public QuotaConsumeResult consume(Long userId, long sttSecondsDelta, long geminiCharsDelta) {
        return consumeOnce(userId, sttSecondsDelta, geminiCharsDelta, null, null, true);
    }

    /**
     * Study path without explicit quotaType (defaults resolved server-side).
     * With an idempotency key, transport failures become UNKNOWN (never fail-open to ALLOWED).
     */
    public QuotaConsumeResult consume(
            Long userId, long sttSecondsDelta, long geminiCharsDelta, String idempotencyKey) {
        return consume(userId, sttSecondsDelta, geminiCharsDelta, idempotencyKey, null);
    }

    /**
     * Study consume with durable idempotency + quotaType.
     * Retries UNKNOWN transport errors up to 3 attempts with the same key.
     */
    public QuotaConsumeResult consume(
            Long userId,
            long sttSecondsDelta,
            long geminiCharsDelta,
            String idempotencyKey,
            String quotaType) {
        boolean legacyFailOpen = !StringUtils.hasText(idempotencyKey);
        QuotaConsumeResult last = null;
        for (int attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt++) {
            last = consumeOnce(
                    userId, sttSecondsDelta, geminiCharsDelta, idempotencyKey, quotaType, legacyFailOpen);
            if (last.status() != QuotaConsumeStatus.UNKNOWN || !last.retryable()) {
                return last;
            }
            if (attempt < MAX_TRANSPORT_ATTEMPTS) {
                sleepBriefly();
            }
        }
        return last;
    }

    private QuotaConsumeResult consumeOnce(
            Long userId,
            long sttSecondsDelta,
            long geminiCharsDelta,
            String idempotencyKey,
            String quotaType,
            boolean legacyFailOpen) {
        String key = StringUtils.hasText(idempotencyKey) ? idempotencyKey.trim() : null;
        String type = StringUtils.hasText(quotaType) ? quotaType.trim() : null;

        if (!StringUtils.hasText(internalServiceToken)) {
            if (legacyFailOpen && quotaFailOpen) {
                log.warn("event=QUOTA_CLIENT_SKIPPED reason=missing_internal_token userId={}", userId);
                return QuotaConsumeResult.allowed(key, type, null);
            }
            if (!legacyFailOpen) {
                // Study path: never fail-open to ALLOWED; config error is not retryable.
                log.error("event=QUOTA_CLIENT_UNKNOWN reason=missing_internal_token userId={}", userId);
                return QuotaConsumeResult.unknown(key, type, "QUOTA_CLIENT_UNCONFIGURED", false);
            }
            log.error("event=QUOTA_CLIENT_DENIED reason=missing_internal_token userId={}", userId);
            return QuotaConsumeResult.denied(key, type, null, "QUOTA_CLIENT_UNCONFIGURED");
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("X-Internal-Service-Token", internalServiceToken);

        Map<String, Object> body = new HashMap<>();
        body.put("userId", userId);
        body.put("sttSecondsDelta", Math.max(0, sttSecondsDelta));
        body.put("geminiCharsDelta", Math.max(0, geminiCharsDelta));
        if (key != null) {
            body.put("idempotencyKey", key);
        }
        if (type != null) {
            body.put("quotaType", type);
        }

        try {
            ResponseEntity<Map> response = restTemplate.exchange(
                    normalizeBaseUrl(userApiBaseUrl) + "/internal/quota/consume",
                    HttpMethod.POST,
                    new HttpEntity<>(body, headers),
                    Map.class
            );
            Map<?, ?> payload = response.getBody();
            if (payload == null) {
                if (legacyFailOpen && quotaFailOpen) {
                    return QuotaConsumeResult.allowed(key, type, null);
                }
                return QuotaConsumeResult.unknown(key, type, "QUOTA_EMPTY_RESPONSE");
            }
            return parseSuccess(payload, key, type, legacyFailOpen);
        } catch (ResourceAccessException ex) {
            return handleTransportFailure(userId, key, type, legacyFailOpen, "QUOTA_TRANSPORT_ERROR", ex);
        } catch (HttpStatusCodeException ex) {
            return classifyHttpStatus(userId, key, type, legacyFailOpen, ex);
        } catch (RestClientException ex) {
            return handleTransportFailure(userId, key, type, legacyFailOpen, "QUOTA_CLIENT_ERROR", ex);
        } catch (Exception ex) {
            return handleTransportFailure(userId, key, type, legacyFailOpen, "QUOTA_CLIENT_ERROR", ex);
        }
    }

    /**
     * Study-path HTTP classification. NEVER maps UNKNOWN to DENIED.
     * Retryable: 429 / 502 / 503 / 504. Non-retryable client/config errors otherwise.
     */
    private QuotaConsumeResult classifyHttpStatus(
            Long userId,
            String key,
            String type,
            boolean legacyFailOpen,
            HttpStatusCodeException ex) {
        int code = ex.getStatusCode().value();
        if (code == 429 || code == 502 || code == 503 || code == 504) {
            return handleTransportFailure(
                    userId, key, type, legacyFailOpen, "QUOTA_HTTP_" + code, ex);
        }
        if (legacyFailOpen && quotaFailOpen) {
            log.warn("event=QUOTA_CLIENT_FAIL_OPEN userId={} httpStatus={}", userId, code);
            return QuotaConsumeResult.allowed(key, type, null);
        }
        String errorCode = mapNonRetryableHttpError(code);
        log.error(
                "event=QUOTA_CLIENT_HTTP_ERROR userId={} httpStatus={} errorCode={} retryable=false",
                userId,
                code,
                errorCode);
        return QuotaConsumeResult.unknown(key, type, errorCode, false);
    }

    private static String mapNonRetryableHttpError(int code) {
        return switch (code) {
            case 400, 405, 422 -> "QUOTA_REQUEST_INVALID";
            case 401 -> "QUOTA_SERVICE_UNAUTHORIZED";
            case 403 -> "QUOTA_SERVICE_FORBIDDEN";
            case 404 -> "QUOTA_ENDPOINT_NOT_FOUND";
            default -> "QUOTA_HTTP_" + code;
        };
    }

    private QuotaConsumeResult parseSuccess(
            Map<?, ?> payload, String key, String type, boolean legacyFailOpen) {
        Object statusObj = payload.get("status");
        if (statusObj != null) {
            String status = String.valueOf(statusObj).trim().toUpperCase();
            if ("ALLOWED".equals(status)) {
                return QuotaConsumeResult.allowed(key, type, payload);
            }
            if ("DENIED".equals(status)) {
                return QuotaConsumeResult.denied(key, type, payload, "QUOTA_EXCEEDED");
            }
        }
        Object allowed = payload.get("allowed");
        if (allowed instanceof Boolean b) {
            return b
                    ? QuotaConsumeResult.allowed(key, type, payload)
                    : QuotaConsumeResult.denied(key, type, payload, "QUOTA_EXCEEDED");
        }
        if (legacyFailOpen && quotaFailOpen) {
            return QuotaConsumeResult.allowed(key, type, payload);
        }
        return QuotaConsumeResult.unknown(key, type, "QUOTA_AMBIGUOUS_RESPONSE");
    }

    private QuotaConsumeResult handleTransportFailure(
            Long userId,
            String key,
            String type,
            boolean legacyFailOpen,
            String errorCode,
            Exception ex) {
        if (legacyFailOpen && quotaFailOpen) {
            log.warn(
                    "event=QUOTA_CLIENT_FAIL_OPEN userId={} errorCode={} message={}",
                    userId,
                    errorCode,
                    ex.getMessage());
            return QuotaConsumeResult.allowed(key, type, null);
        }
        // Study path (or fail-closed legacy): UNKNOWN, never DENIED for transport.
        log.warn(
                "event=QUOTA_CLIENT_UNKNOWN userId={} errorCode={} message={}",
                userId,
                errorCode,
                ex.getMessage());
        return QuotaConsumeResult.unknown(key, type, errorCode);
    }

    private static void sleepBriefly() {
        try {
            Thread.sleep(RETRY_SLEEP_MS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        }
    }

    private static String normalizeBaseUrl(String baseUrl) {
        if (baseUrl == null) {
            return "";
        }
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }
}
