package com.example.processingservice.controller.dto;

import java.util.Map;

public record AnalysisResponse(
        Long meetingId,
        Map<String, Object> data
) {
}