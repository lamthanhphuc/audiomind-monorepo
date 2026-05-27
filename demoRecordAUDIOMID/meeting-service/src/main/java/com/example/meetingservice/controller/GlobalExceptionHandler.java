package com.example.meetingservice.controller;

import com.example.meetingservice.config.TraceIdFilter;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;
import org.slf4j.MDC;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(NoSuchElementException.class)
    public ResponseEntity<ApiErrorResponse> handleNotFound(NoSuchElementException ex, HttpServletRequest request) {
        return buildResponse(
                ErrorCode.RESOURCE_NOT_FOUND,
                HttpStatus.NOT_FOUND,
                ex.getMessage(),
                request,
                null);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiErrorResponse> handleBadRequest(IllegalArgumentException ex, HttpServletRequest request) {
        ErrorCode code = isLanguageError(ex.getMessage()) ? ErrorCode.INVALID_LANGUAGE : ErrorCode.VALIDATION_ERROR;
        return buildResponse(
                code,
                HttpStatus.BAD_REQUEST,
                ex.getMessage(),
                request,
                null);
    }

    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<ApiErrorResponse> handleResponseStatus(ResponseStatusException ex, HttpServletRequest request) {
        HttpStatus status = HttpStatus.valueOf(ex.getStatusCode().value());
        ErrorCode code = mapResponseStatusErrorCode(status, ex.getReason(), request);
        return buildResponse(
                code,
                status,
                ex.getReason(),
                request,
                null);
    }

    @ExceptionHandler(DataAccessException.class)
    public ResponseEntity<ApiErrorResponse> handleDataAccess(DataAccessException ex, HttpServletRequest request) {
        return buildResponse(
                ErrorCode.DATABASE_UNAVAILABLE,
                HttpStatus.SERVICE_UNAVAILABLE,
                "Database dependency is unavailable",
                request,
                null);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiErrorResponse> handleUnexpected(Exception ex, HttpServletRequest request) {
        return buildResponse(
                ErrorCode.INTERNAL_ERROR,
                HttpStatus.INTERNAL_SERVER_ERROR,
                null,
                request,
                null);
    }

    private ResponseEntity<ApiErrorResponse> buildResponse(
            ErrorCode code,
            HttpStatus status,
            String message,
            HttpServletRequest request,
            Map<String, Object> details
    ) {
        String traceId = resolveTraceId(request);
        String resolvedMessage = shouldUseDefaultMessage(code)
                ? code.defaultMessage()
                : sanitizeMessage(message, code.defaultMessage());
        ApiErrorResponse body = new ApiErrorResponse(
                code.name(),
                resolvedMessage,
                status.value(),
                Instant.now().toString(),
                traceId,
                request == null ? null : request.getRequestURI(),
                details
        );
        return ResponseEntity.status(status)
                .header(TraceIdFilter.TRACE_HEADER, traceId)
                .body(body);
    }

    private ErrorCode mapResponseStatusErrorCode(HttpStatus status, String reason, HttpServletRequest request) {
        String normalizedReason = normalize(reason);
        String path = normalize(request == null ? null : request.getRequestURI());

        return switch (status) {
            case NOT_FOUND -> {
                if (path.endsWith("/analysis")) {
                    yield ErrorCode.ANALYSIS_NOT_READY;
                }
                if (path.endsWith("/transcript")) {
                    yield ErrorCode.TRANSCRIPT_NOT_READY;
                }
                yield ErrorCode.RESOURCE_NOT_FOUND;
            }
            case BAD_REQUEST, UNSUPPORTED_MEDIA_TYPE, PAYLOAD_TOO_LARGE -> isLanguageError(normalizedReason)
                    ? ErrorCode.INVALID_LANGUAGE
                    : ErrorCode.VALIDATION_ERROR;
            case UNAUTHORIZED -> ErrorCode.UNAUTHORIZED;
            case FORBIDDEN -> ErrorCode.FORBIDDEN;
            case CONFLICT -> ErrorCode.CONFLICT;
            case SERVICE_UNAVAILABLE -> ErrorCode.SERVICE_UNAVAILABLE;
            case BAD_GATEWAY -> normalizedReason.contains("gemini")
                    ? ErrorCode.GEMINI_ANALYSIS_FAILED
                    : ErrorCode.SERVICE_UNAVAILABLE;
            default -> status.is5xxServerError() ? ErrorCode.INTERNAL_ERROR : ErrorCode.SERVICE_UNAVAILABLE;
        };
    }

    private String sanitizeMessage(String candidate, String fallback) {
        if (candidate == null || candidate.isBlank()) {
            return fallback;
        }
        String normalized = normalize(candidate);
        if (normalized.length() > 280
                || normalized.contains("password")
                || normalized.contains("secret")
                || normalized.contains("token")
                || normalized.contains("authorization")
                || normalized.contains("bearer")
                || normalized.contains("traceback")
                || normalized.contains("stack trace")) {
            return fallback;
        }
        return candidate;
    }

    private boolean shouldUseDefaultMessage(ErrorCode code) {
        return switch (code) {
            case ANALYSIS_NOT_READY,
                    TRANSCRIPT_NOT_READY,
                    UNAUTHORIZED,
                    FORBIDDEN,
                    AI_SERVICE_UNAVAILABLE,
                    DATABASE_UNAVAILABLE,
                    SERVICE_UNAVAILABLE,
                    DEEPGRAM_UNAVAILABLE,
                    GEMINI_UNAVAILABLE,
                    GEMINI_ANALYSIS_FAILED,
                    EMPTY_TRANSCRIPT,
                    INTERNAL_ERROR -> true;
            default -> false;
        };
    }

    private String resolveTraceId(HttpServletRequest request) {
        if (request != null) {
            String fromHeader = request.getHeader(TraceIdFilter.TRACE_HEADER);
            if (fromHeader != null && !fromHeader.isBlank()) {
                return fromHeader;
            }
            String lowerHeader = request.getHeader("x-trace-id");
            if (lowerHeader != null && !lowerHeader.isBlank()) {
                return lowerHeader;
            }
        }
        String fromMdc = MDC.get("traceId");
        if (fromMdc != null && !fromMdc.isBlank()) {
            return fromMdc;
        }
        return UUID.randomUUID().toString();
    }

    private boolean isLanguageError(String message) {
        return normalize(message).contains("language");
    }

    private String normalize(String value) {
        if (value == null) {
            return "";
        }
        return value.trim().toLowerCase(Locale.ROOT);
    }
}
