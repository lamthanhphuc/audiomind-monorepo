package com.example.processingservice.controller.dto;

public record ProcessingStatusResponse(
        Long meetingId,
        String status,
        Integer progress,
        String stage,
        String error,
        String updatedAt
) {
}