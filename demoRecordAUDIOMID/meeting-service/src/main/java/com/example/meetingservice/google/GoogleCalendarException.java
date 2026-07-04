package com.example.meetingservice.google;

import java.util.Map;

public class GoogleCalendarException extends RuntimeException {
    private final GoogleCalendarError error;
    private final Map<String, Object> details;
    private final boolean retryable;

    public GoogleCalendarException(GoogleCalendarError error) {
        this(error, Map.of(), false, null);
    }

    public GoogleCalendarException(GoogleCalendarError error, Map<String, Object> details) {
        this(error, details, false, null);
    }

    public GoogleCalendarException(GoogleCalendarError error, boolean retryable, Throwable cause) {
        this(error, Map.of(), retryable, cause);
    }

    private GoogleCalendarException(
            GoogleCalendarError error,
            Map<String, Object> details,
            boolean retryable,
            Throwable cause) {
        super(error.message(), cause);
        this.error = error;
        this.details = details == null ? Map.of() : Map.copyOf(details);
        this.retryable = retryable;
    }

    public GoogleCalendarError error() {
        return error;
    }

    public Map<String, Object> details() {
        return details;
    }

    public boolean retryable() {
        return retryable;
    }
}
