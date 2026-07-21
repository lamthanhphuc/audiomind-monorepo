package com.example.meetingservice.controller.dto;

import java.time.LocalDateTime;

public record SubjectMeetingResponse(
        Long id,
        String title,
        String status,
        String language,
        LocalDateTime createdAt,
        Long subjectId) {}
