package com.example.meetingservice.controller.dto;

public record StandaloneGoogleCalendarResponse(
        String creationStatus,
        String conferenceStatus,
        String googleCalendarEventId,
        String meetUri,
        String hangoutLink,
        String htmlLink,
        String errorCode) {
}
