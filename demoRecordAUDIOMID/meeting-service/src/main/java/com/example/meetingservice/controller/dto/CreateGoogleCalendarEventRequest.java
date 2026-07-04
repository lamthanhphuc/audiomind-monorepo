package com.example.meetingservice.controller.dto;

import java.util.List;

public record CreateGoogleCalendarEventRequest(
        String startDateTime,
        String endDateTime,
        String timeZone,
        List<String> attendees) {
}
