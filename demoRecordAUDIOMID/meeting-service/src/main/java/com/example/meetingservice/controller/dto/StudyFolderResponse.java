package com.example.meetingservice.controller.dto;

import java.time.LocalDateTime;

public record StudyFolderResponse(
        Long id,
        Long ownerUserId,
        Long parentFolderId,
        String name,
        String color,
        LocalDateTime createdAt,
        LocalDateTime updatedAt,
        LocalDateTime deletedAt,
        long subjectCount) {}
