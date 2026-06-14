package com.example.processingservice.controller.dto;

import java.util.List;

public record TranscriptEvidenceMatch(
        String evidenceId,
        String segmentId,
        int index,
        String speaker,
        double startTime,
        double endTime,
        String text,
        boolean textTruncated,
        List<TranscriptEvidenceContext> contextBefore,
        List<TranscriptEvidenceContext> contextAfter,
        double score,
        int rank,
        String matchType
) {
}
