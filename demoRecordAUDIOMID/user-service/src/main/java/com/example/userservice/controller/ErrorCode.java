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
    GOOGLE_OAUTH_STATE_INVALID(400, "Google OAuth state is invalid"),
    GOOGLE_OAUTH_NOT_CONFIGURED(503, "Google login is not configured"),
    GOOGLE_OAUTH_PROVIDER_ERROR(502, "Google authentication failed"),
    GOOGLE_EMAIL_CONFLICT(409, "Email already exists; sign in locally before linking Google"),
    GOOGLE_LOGIN_TICKET_INVALID(400, "Google login ticket is invalid"),
    GOOGLE_LOGIN_TICKET_USED(400, "Google login ticket was already used"),
    GOOGLE_LOGIN_TICKET_EXPIRED(400, "Google login ticket has expired"),
    GOOGLE_ACCOUNT_ALREADY_LINKED(409, "Google account is already linked"),
    GOOGLE_SCOPE_MISSING(403, "Required Google permission is missing"),
    GOOGLE_REFRESH_TOKEN_REVOKED(401, "Google authorization was revoked"),
    GOOGLE_CANNOT_UNLINK_LAST_IDENTITY(400, "Set a password before unlinking Google"),
    GOOGLE_TOKEN_KEY_UNAVAILABLE(503, "Google token encryption key is unavailable"),
    GOOGLE_TOKEN_DECRYPTION_FAILED(500, "Google token could not be decrypted"),
    GOOGLE_INTERNAL_CALL_FORBIDDEN(403, "Internal Google token request is forbidden"),
    ZOOM_OAUTH_STATE_INVALID(400, "Zoom OAuth state is invalid"),
    ZOOM_OAUTH_NOT_CONFIGURED(503, "Zoom integration is not configured"),
    ZOOM_OAUTH_PROVIDER_ERROR(502, "Zoom authentication failed"),
    ZOOM_ACCOUNT_ALREADY_LINKED(409, "Zoom account is already linked"),
    ZOOM_REFRESH_TOKEN_REVOKED(401, "Zoom authorization was revoked"),
    ZOOM_TOKEN_KEY_UNAVAILABLE(503, "Zoom token encryption key is unavailable"),
    ZOOM_TOKEN_DECRYPTION_FAILED(500, "Zoom token could not be decrypted"),
    ZOOM_RECORDING_NOT_FOUND(404, "Zoom recording was not found"),
    ZOOM_RECORDING_IMPORT_FAILED(502, "Unable to import Zoom recording"),
    TEAMS_OAUTH_NOT_CONFIGURED(503, "Microsoft Teams integration is not configured"),
    VALIDATION_ERROR(400, "Request validation failed"),
    RATE_LIMITED(429, "Too many requests"),
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
