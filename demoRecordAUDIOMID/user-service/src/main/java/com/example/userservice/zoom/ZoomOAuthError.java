package com.example.userservice.zoom;

import org.springframework.http.HttpStatus;

public enum ZoomOAuthError {
    ZOOM_OAUTH_STATE_INVALID(HttpStatus.BAD_REQUEST, "Zoom OAuth state is invalid"),
    ZOOM_OAUTH_NOT_CONFIGURED(HttpStatus.SERVICE_UNAVAILABLE, "Zoom integration is not configured"),
    ZOOM_OAUTH_PROVIDER_ERROR(HttpStatus.BAD_GATEWAY, "Zoom authentication failed"),
    ZOOM_ACCOUNT_ALREADY_LINKED(HttpStatus.CONFLICT, "Zoom account is already linked"),
    ZOOM_REFRESH_TOKEN_REVOKED(HttpStatus.UNAUTHORIZED, "Zoom authorization was revoked"),
    ZOOM_TOKEN_KEY_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "Zoom token encryption key is unavailable"),
    ZOOM_TOKEN_DECRYPTION_FAILED(HttpStatus.INTERNAL_SERVER_ERROR, "Zoom token could not be decrypted"),
    ZOOM_RECORDING_NOT_FOUND(HttpStatus.NOT_FOUND, "Zoom recording was not found"),
    ZOOM_RECORDING_IMPORT_FAILED(HttpStatus.BAD_GATEWAY, "Unable to import Zoom recording");

    private final HttpStatus status;
    private final String message;

    ZoomOAuthError(HttpStatus status, String message) {
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
