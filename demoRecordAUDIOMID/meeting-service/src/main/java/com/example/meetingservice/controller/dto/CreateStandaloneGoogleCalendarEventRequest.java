package com.example.meetingservice.controller.dto;

import java.util.List;

public record CreateStandaloneGoogleCalendarEventRequest(
        String title,
        String startDateTime,
        String endDateTime,
        String timeZone,
        List<String> attendees) {
}
