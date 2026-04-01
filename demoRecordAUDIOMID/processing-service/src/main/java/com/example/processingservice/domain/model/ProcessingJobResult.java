package com.example.processingservice.domain.model;

public record ProcessingJobResult(
        String meetingId,
        String status,
        String transcript,
        String summary
) {
}
