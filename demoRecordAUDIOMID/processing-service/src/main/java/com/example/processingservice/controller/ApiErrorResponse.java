package com.example.processingservice.controller;

import com.fasterxml.jackson.annotation.JsonInclude;
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
}
