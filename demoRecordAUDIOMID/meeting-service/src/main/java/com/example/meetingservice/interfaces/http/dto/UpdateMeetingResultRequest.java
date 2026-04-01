package com.example.meetingservice.interfaces.http.dto;

public record UpdateMeetingResultRequest(
        String transcript,
        String summary
) {
}
