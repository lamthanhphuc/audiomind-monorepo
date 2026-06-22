package com.example.processingservice.controller;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApiErrorResponse(
        String error,
        String message,
        int status,
        String timestamp,
        String traceId,
        String path,
        Map<String, Object> details
) {
    @JsonProperty("errorCode")
    public String errorCode() {
        return error;
    }
}
