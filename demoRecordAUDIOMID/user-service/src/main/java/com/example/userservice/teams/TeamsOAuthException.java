package com.example.userservice.teams;

public class TeamsOAuthException extends RuntimeException {

    private final TeamsOAuthError error;

    public TeamsOAuthException(TeamsOAuthError error) {
        this(error, null);
    }

    public TeamsOAuthException(TeamsOAuthError error, Throwable cause) {
        super(error.message(), cause);
        this.error = error;
    }

    public TeamsOAuthError error() {
        return error;
    }
}
