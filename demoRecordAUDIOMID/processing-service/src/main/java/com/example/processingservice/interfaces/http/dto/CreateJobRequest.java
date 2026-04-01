package com.example.processingservice.interfaces.http.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public record CreateJobRequest(
        @JsonProperty("meeting_id") String meetingId
) {
}
