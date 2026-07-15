package com.example.meetingservice.controller.dto;

import java.time.LocalDateTime;

public record SubjectResponse(
        Long id,
        Long ownerUserId,
        Long folderId,
        String name,
        String code,
        String semester,
        String description,
        String color,
        LocalDateTime createdAt,
        LocalDateTime updatedAt,
        LocalDateTime archivedAt,
        long meetingCount) {}
