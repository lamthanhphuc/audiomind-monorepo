package com.example.userservice.google;

import org.springframework.http.HttpStatus;

public enum GoogleOAuthError {
    GOOGLE_OAUTH_STATE_INVALID(HttpStatus.BAD_REQUEST, "Google OAuth state is invalid"),
    GOOGLE_OAUTH_NOT_CONFIGURED(HttpStatus.SERVICE_UNAVAILABLE, "Google login is not configured"),
    GOOGLE_OAUTH_PROVIDER_ERROR(HttpStatus.BAD_GATEWAY, "Google authentication failed"),
    GOOGLE_EMAIL_CONFLICT(HttpStatus.CONFLICT, "Email already exists; sign in locally before linking Google"),
    GOOGLE_LOGIN_TICKET_INVALID(HttpStatus.BAD_REQUEST, "Google login ticket is invalid"),
    GOOGLE_LOGIN_TICKET_USED(HttpStatus.BAD_REQUEST, "Google login ticket was already used"),
    GOOGLE_LOGIN_TICKET_EXPIRED(HttpStatus.BAD_REQUEST, "Google login ticket has expired"),
    GOOGLE_ACCOUNT_ALREADY_LINKED(HttpStatus.CONFLICT, "Google account is already linked"),
    GOOGLE_SCOPE_MISSING(HttpStatus.FORBIDDEN, "Required Google permission is missing"),
    GOOGLE_REFRESH_TOKEN_REVOKED(HttpStatus.UNAUTHORIZED, "Google authorization was revoked"),
    GOOGLE_CANNOT_UNLINK_LAST_IDENTITY(HttpStatus.BAD_REQUEST, "Set a password before unlinking Google"),
    GOOGLE_TOKEN_KEY_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "Google token encryption key is unavailable"),
    GOOGLE_TOKEN_DECRYPTION_FAILED(HttpStatus.INTERNAL_SERVER_ERROR, "Google token could not be decrypted"),
    GOOGLE_INTERNAL_CALL_FORBIDDEN(HttpStatus.FORBIDDEN, "Internal Google token request is forbidden");

    private final HttpStatus status;
    private final String message;

    GoogleOAuthError(HttpStatus status, String message) {
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
