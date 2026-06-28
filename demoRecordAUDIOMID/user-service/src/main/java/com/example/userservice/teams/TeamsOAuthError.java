package com.example.userservice.teams;

import org.springframework.http.HttpStatus;

public enum TeamsOAuthError {
    TEAMS_OAUTH_STATE_INVALID(HttpStatus.BAD_REQUEST, "Microsoft Teams OAuth state is invalid"),
    TEAMS_OAUTH_NOT_CONFIGURED(HttpStatus.SERVICE_UNAVAILABLE, "Microsoft Teams integration is not configured"),
    TEAMS_OAUTH_PROVIDER_ERROR(HttpStatus.BAD_GATEWAY, "Microsoft Teams authentication failed"),
    TEAMS_ACCOUNT_ALREADY_LINKED(HttpStatus.CONFLICT, "Microsoft account is already linked"),
    TEAMS_REFRESH_TOKEN_REVOKED(HttpStatus.UNAUTHORIZED, "Microsoft Teams authorization was revoked"),
    TEAMS_TOKEN_KEY_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "Teams token encryption key is unavailable"),
    TEAMS_TOKEN_DECRYPTION_FAILED(HttpStatus.INTERNAL_SERVER_ERROR, "Teams token could not be decrypted"),
    TEAMS_RECORDING_NOT_FOUND(HttpStatus.NOT_FOUND, "Teams recording was not found"),
    TEAMS_RECORDING_IMPORT_FAILED(HttpStatus.BAD_GATEWAY, "Unable to import Teams recording");

    private final HttpStatus status;
    private final String message;

    TeamsOAuthError(HttpStatus status, String message) {
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
