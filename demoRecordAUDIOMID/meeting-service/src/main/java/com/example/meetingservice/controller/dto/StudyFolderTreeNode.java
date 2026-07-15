package com.example.meetingservice.controller.dto;

import java.util.List;

public record StudyFolderTreeNode(
        Long id,
        String name,
        String color,
        Long parentFolderId,
        List<StudyFolderTreeNode> children,
        List<SubjectSummaryResponse> subjects) {}
