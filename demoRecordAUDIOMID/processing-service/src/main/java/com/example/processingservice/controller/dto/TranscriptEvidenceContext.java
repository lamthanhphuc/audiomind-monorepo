package com.example.processingservice.controller.dto;

public record TranscriptEvidenceContext(
        String segmentId,
        int index,
        String speaker,
        double startTime,
        double endTime,
        String text,
        boolean textTruncated
) {
}
