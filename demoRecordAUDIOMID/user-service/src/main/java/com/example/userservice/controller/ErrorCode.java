package com.example.userservice.controller;

public enum ErrorCode {
    ANALYSIS_NOT_READY(404, "Analysis is not ready yet"),
    TRANSCRIPT_NOT_READY(404, "Transcript is not ready yet"),
    RESOURCE_NOT_FOUND(404, "Resource not found"),
    UNAUTHORIZED(401, "Unauthorized"),
    FORBIDDEN(403, "Forbidden"),
    CONFLICT(409, "Request conflicts with current resource state"),
    AI_SERVICE_UNAVAILABLE(503, "AI service is unavailable"),
    DATABASE_UNAVAILABLE(503, "Database dependency is unavailable"),
    SERVICE_UNAVAILABLE(503, "Service is unavailable"),
    DEEPGRAM_UNAVAILABLE(503, "Deepgram service is unavailable"),
    GEMINI_UNAVAILABLE(503, "Gemini service is unavailable"),
    GEMINI_ANALYSIS_FAILED(502, "Gemini analysis failed"),
    INVALID_LANGUAGE(400, "Invalid language"),
    EMPTY_TRANSCRIPT(422, "Transcript is empty"),
    DUPLICATE_REQUEST_SKIPPED(200, "Duplicate request skipped"),
    VALIDATION_ERROR(400, "Request validation failed"),
    INTERNAL_ERROR(500, "Unexpected server error");

    private final int status;
    private final String defaultMessage;

    ErrorCode(int status, String defaultMessage) {
        this.status = status;
        this.defaultMessage = defaultMessage;
    }

    public int status() {
        return status;
    }

    public String defaultMessage() {
        return defaultMessage;
    }
}
