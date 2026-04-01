package com.example.meetingservice.interfaces.http.dto;

public record MeetingResponse(
        String id,
        String status,
        String transcript,
        String summary
) {
}
