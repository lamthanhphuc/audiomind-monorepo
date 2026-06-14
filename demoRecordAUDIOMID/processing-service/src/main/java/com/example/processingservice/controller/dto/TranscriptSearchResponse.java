package com.example.processingservice.controller.dto;

import java.util.List;

public record TranscriptSearchResponse(
        Long meetingId,
        String query,
        String normalizedQuery,
        String transcriptMode,
        String canonicalTranscriptHash,
        String canonicalTranscriptVersion,
        List<TranscriptEvidenceMatch> matches
) {
}
