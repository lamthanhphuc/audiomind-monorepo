package com.example.processingservice.service;

import java.util.Locale;
import java.util.Set;

import org.springframework.web.client.HttpStatusCodeException;

import io.github.resilience4j.circuitbreaker.CallNotPermittedException;

public final class AnalysisFailureMapping {

    public static final String ANALYSIS_STATUS_FAILED_RETRYABLE = "ANALYSIS_FAILED_RETRYABLE";

    public static final String ERROR_CODE_CIRCUIT_OPEN = "CIRCUIT_OPEN";
    public static final String ERROR_CODE_GEMINI_UNAVAILABLE = "GEMINI_UNAVAILABLE";
    public static final String ERROR_CODE_GEMINI_ANALYSIS_FAILED = "GEMINI_ANALYSIS_FAILED";
    public static final String ERROR_CODE_EMPTY_TRANSCRIPT = "EMPTY_TRANSCRIPT";
    public static final String ERROR_CODE_AI_SERVICE_UNAVAILABLE = "AI_SERVICE_UNAVAILABLE";
    public static final String ERROR_CODE_GEMINI_RATE_LIMITED = "GEMINI_RATE_LIMITED";
    public static final String ERROR_CODE_GEMINI_QUOTA_EXHAUSTED = "GEMINI_QUOTA_EXHAUSTED";

    public static final int DEFAULT_CIRCUIT_OPEN_RETRY_AFTER_SECONDS = 10;

    private static final Set<String> RETRYABLE_ERROR_CODES = Set.of(
            ERROR_CODE_CIRCUIT_OPEN,
            ERROR_CODE_GEMINI_UNAVAILABLE,
            ERROR_CODE_GEMINI_ANALYSIS_FAILED,
            ERROR_CODE_AI_SERVICE_UNAVAILABLE,
            ERROR_CODE_GEMINI_RATE_LIMITED,
            ERROR_CODE_GEMINI_QUOTA_EXHAUSTED
    );

    private AnalysisFailureMapping() {
    }

    public static String mapFailureCode(Exception ex) {
        if (ex instanceof CallNotPermittedException) {
            return ERROR_CODE_CIRCUIT_OPEN;
        }
        if (isCallNotPermittedException(ex)) {
            return ERROR_CODE_CIRCUIT_OPEN;
        }
        if (ex instanceof HttpStatusCodeException httpEx) {
            int status = httpEx.getStatusCode().value();
            String statusText = safeText(httpEx.getStatusText()).toLowerCase(Locale.ROOT);
            String body = safeText(httpEx.getResponseBodyAsString()).toLowerCase(Locale.ROOT);
            if (status == 422 || statusText.contains("empty transcript") || body.contains("empty_transcript")) {
                return ERROR_CODE_EMPTY_TRANSCRIPT;
            }
            if (status == 429 || body.contains("gemini_rate_limited") || body.contains("gemini_quota_exhausted")) {
                return body.contains("gemini_quota_exhausted") ? ERROR_CODE_GEMINI_QUOTA_EXHAUSTED : ERROR_CODE_GEMINI_RATE_LIMITED;
            }
            if (status == 503 || statusText.contains("service unavailable") || body.contains("gemini_unavailable")) {
                return ERROR_CODE_GEMINI_UNAVAILABLE;
            }
            if (status == 502) {
                return ERROR_CODE_GEMINI_ANALYSIS_FAILED;
            }
            return ERROR_CODE_AI_SERVICE_UNAVAILABLE;
        }
        return ERROR_CODE_GEMINI_ANALYSIS_FAILED;
    }

    public static boolean isRetryableErrorCode(String errorCode) {
        if (errorCode == null || errorCode.isBlank()) {
            return false;
        }
        return RETRYABLE_ERROR_CODES.contains(errorCode.trim().toUpperCase(Locale.ROOT));
    }

    public static String resolveFailedAnalysisStatus(String errorCode) {
        return isRetryableErrorCode(errorCode) ? ANALYSIS_STATUS_FAILED_RETRYABLE : "FAILED";
    }

    public static int resolveRetryAfterSeconds(String errorCode, int overrideSeconds) {
        if (overrideSeconds > 0) {
            return overrideSeconds;
        }
        if (ERROR_CODE_CIRCUIT_OPEN.equals(errorCode)) {
            return DEFAULT_CIRCUIT_OPEN_RETRY_AFTER_SECONDS;
        }
        return 0;
    }

    private static boolean isCallNotPermittedException(Exception ex) {
        Throwable current = ex;
        while (current != null) {
            if (current instanceof CallNotPermittedException) {
                return true;
            }
            String simpleName = current.getClass().getSimpleName();
            if ("CallNotPermittedException".equals(simpleName)) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private static String safeText(Object value) {
        if (value == null) {
            return "";
        }
        return String.valueOf(value).trim();
    }
}
