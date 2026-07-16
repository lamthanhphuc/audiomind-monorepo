package com.example.meetingservice.controller.dto;

import java.time.LocalDateTime;

public record SubjectSummaryResponse(
        Long id,
        String name,
        String code,
        String semester,
        String color,
        Long folderId,
        LocalDateTime archivedAt,
        long meetingCount) {}
