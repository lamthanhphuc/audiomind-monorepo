package com.example.processingservice.controller.dto;

public record ProcessStartResponse(
        Long meetingId,
        String status,
        String error,
        String updatedAt
) {
}