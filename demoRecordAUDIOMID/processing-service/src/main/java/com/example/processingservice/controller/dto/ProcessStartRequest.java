package com.example.processingservice.controller.dto;

import com.fasterxml.jackson.annotation.JsonAlias;

import java.util.List;

public record ProcessStartRequest(
        Long meeting_id,
        String audio_path,
        @JsonAlias("fileId") String file_id,
        String topic,
        List<String> glossary_terms,
        String language
) {
}
