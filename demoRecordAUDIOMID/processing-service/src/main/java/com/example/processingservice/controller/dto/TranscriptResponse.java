package com.example.processingservice.controller.dto;

import java.util.Map;

public record TranscriptResponse(
        Long meetingId,
        Map<String, Object> data
) {
}