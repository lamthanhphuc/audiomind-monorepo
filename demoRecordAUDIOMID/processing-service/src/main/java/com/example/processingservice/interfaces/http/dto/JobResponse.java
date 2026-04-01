package com.example.processingservice.interfaces.http.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public record JobResponse(
        @JsonProperty("meeting_id") String meetingId,
        String status,
        String transcript,
        String summary
) {
}
