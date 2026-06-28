package com.example.userservice.zoom;

import java.util.Map;

public class ZoomOAuthException extends RuntimeException {

    private final ZoomOAuthError error;
    private final Map<String, Object> details;

    public ZoomOAuthException(ZoomOAuthError error) {
        this(error, null, null);
    }

    public ZoomOAuthException(ZoomOAuthError error, Throwable cause) {
        this(error, null, cause);
    }

    public ZoomOAuthException(ZoomOAuthError error, Map<String, Object> details) {
        this(error, details, null);
    }

    public ZoomOAuthException(ZoomOAuthError error, Map<String, Object> details, Throwable cause) {
        super(error.message(), cause);
        this.error = error;
        this.details = details;
    }

    public ZoomOAuthError error() {
        return error;
    }

    public Map<String, Object> details() {
        return details;
    }
}
