package com.example.meetingservice.controller.dto;

public record CreateScheduledMeetingRequest(
        String title,
        String startDateTime,
        String endDateTime,
        String timeZone,
        String language) {
}
