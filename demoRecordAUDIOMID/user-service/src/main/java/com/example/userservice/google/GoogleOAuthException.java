package com.example.userservice.google;

public class GoogleOAuthException extends RuntimeException {

    private final GoogleOAuthError error;
    private final java.util.Map<String, Object> details;

    public GoogleOAuthException(GoogleOAuthError error) {
        this(error, java.util.Map.of(), null);
    }

    public GoogleOAuthException(GoogleOAuthError error, Throwable cause) {
        this(error, java.util.Map.of(), cause);
    }

    public GoogleOAuthException(GoogleOAuthError error, java.util.Map<String, Object> details) {
        this(error, details, null);
    }

    private GoogleOAuthException(
            GoogleOAuthError error,
            java.util.Map<String, Object> details,
            Throwable cause) {
        super(error.message(), cause);
        this.error = error;
        this.details = details == null ? java.util.Map.of() : java.util.Map.copyOf(details);
    }

    public GoogleOAuthError error() {
        return error;
    }

    public java.util.Map<String, Object> details() {
        return details;
    }
}
