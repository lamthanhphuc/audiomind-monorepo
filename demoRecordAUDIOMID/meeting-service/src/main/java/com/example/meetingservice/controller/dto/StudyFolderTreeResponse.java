package com.example.meetingservice.controller.dto;

import java.util.List;

public record StudyFolderTreeResponse(
        List<StudyFolderTreeNode> folders, List<SubjectSummaryResponse> rootSubjects) {}
