package com.example.processingservice.controller.dto;

public record ProcessingStatusResponse(
        Long meetingId,
        String status,
        String error,
        String updatedAt
) {
}