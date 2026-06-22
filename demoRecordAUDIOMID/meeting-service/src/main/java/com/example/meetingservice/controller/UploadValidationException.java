package com.example.meetingservice.controller;

import org.springframework.http.HttpStatus;

public class UploadValidationException extends RuntimeException {

    private final ErrorCode errorCode;
    private final HttpStatus status;

    public UploadValidationException(ErrorCode errorCode, HttpStatus status) {
        super(errorCode.defaultMessage());
        this.errorCode = errorCode;
        this.status = status;
    }

    public ErrorCode errorCode() {
        return errorCode;
    }

    public HttpStatus status() {
        return status;
    }
}
