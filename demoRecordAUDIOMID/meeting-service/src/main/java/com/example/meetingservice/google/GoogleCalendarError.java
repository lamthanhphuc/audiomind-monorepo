package com.example.meetingservice.google;

import org.springframework.http.HttpStatus;

public enum GoogleCalendarError {
    GOOGLE_SCOPE_MISSING(HttpStatus.FORBIDDEN, "Required Google Calendar permission is missing"),
    GOOGLE_REFRESH_TOKEN_REVOKED(HttpStatus.UNAUTHORIZED, "Google authorization was revoked"),
    GOOGLE_CALENDAR_CREATION_IN_PROGRESS(HttpStatus.ACCEPTED, "Google Calendar event creation is in progress"),
    GOOGLE_CALENDAR_VALIDATION_ERROR(HttpStatus.BAD_REQUEST, "Google Calendar request is invalid"),
    GOOGLE_CALENDAR_PERMISSION_DENIED(HttpStatus.FORBIDDEN, "Google Calendar access was denied"),
    GOOGLE_CALENDAR_API_ERROR(HttpStatus.BAD_GATEWAY, "Google Calendar is unavailable"),
    GOOGLE_INTERNAL_TOKEN_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "Google authorization service is unavailable");

    private final HttpStatus status;
    private final String message;

    GoogleCalendarError(HttpStatus status, String message) {
        this.status = status;
        this.message = message;
    }

    public HttpStatus status() {
        return status;
    }

    public String message() {
        return message;
    }
}
