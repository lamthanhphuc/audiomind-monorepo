package com.example.meetingservice.controller.dto;

public record GoogleCalendarStatusResponse(
        Long meetingId,
        String creationStatus,
        String conferenceStatus,
        String googleCalendarEventId,
        String meetUri,
        String hangoutLink,
        String htmlLink,
        String errorCode) {
}
