package com.example.userservice.controller.dto;

public record TeamsImportRecordingResponse(
        Long meetingId,
        boolean duplicate,
        boolean reused,
        boolean processingStarted,
        String title,
        String status
) {
}
