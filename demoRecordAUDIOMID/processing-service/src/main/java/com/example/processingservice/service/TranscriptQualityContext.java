package com.example.processingservice.service;

import java.util.List;
import java.util.Map;

/**
 * Pre-stabilization canonical rows + evidence stats from ai-service (Epic 3 §5.3.2).
 */
public record TranscriptQualityContext(
        String canonicalTranscriptVersion,
        String canonicalTranscriptHash,
        List<Map<String, Object>> canonicalTranscriptRows,
        Map<String, Object> evidenceStats
) {
    public static TranscriptQualityContext empty() {
        return new TranscriptQualityContext(null, null, List.of(), Map.of());
    }

    public boolean isReady() {
        return canonicalTranscriptRows != null
                && !canonicalTranscriptRows.isEmpty()
                && evidenceStats != null
                && !evidenceStats.isEmpty()
                && canonicalTranscriptHash != null
                && !canonicalTranscriptHash.isBlank();
    }
}
