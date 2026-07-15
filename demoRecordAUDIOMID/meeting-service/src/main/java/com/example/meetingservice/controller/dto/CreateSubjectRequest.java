package com.example.meetingservice.controller.dto;

public record CreateSubjectRequest(
        String name,
        String code,
        String semester,
        String description,
        String color,
        Long folderId) {}
