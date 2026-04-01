package com.example.meetingservice.domain.model;

public record MeetingRecord(
        String id,
        String status,
        String transcript,
        String summary
) {
}
