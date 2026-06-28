package com.example.meetingservice.controller.dto;

public record GoogleCalendarMeetingListItem(
        Long linkId,
        Long meetingId,
        String title,
        String scheduledStartAt,
        String scheduledEndAt,
        String creationStatus,
        String meetUri,
        String htmlLink) {
}