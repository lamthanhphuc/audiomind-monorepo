package com.example.processingservice.service;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Epic 3 search/evidence options passed from ProcessingService.
 */
public record TranscriptSearchOptions(
        boolean evidenceQaEnabled,
        boolean searchVerifyEnabled,
        JsonNode policyRoot,
        TranscriptQualityContext qualityContext
) {
    public static TranscriptSearchOptions baseline() {
        return new TranscriptSearchOptions(false, false, null, TranscriptQualityContext.empty());
    }

    public int maxLimit() {
        if (policyRoot == null || !searchVerifyEnabled) {
            return 50;
        }
        return policyRoot.path("search").path("maxLimit").asInt(50);
    }

    public int maxScanSegments() {
        if (policyRoot == null) {
            return Integer.MAX_VALUE;
        }
        return policyRoot.path("search").path("maxScanSegments").asInt(2000);
    }

    public String scanPreference() {
        if (policyRoot == null) {
            return "recent";
        }
        String pref = policyRoot.path("search").path("scanPreference").asText("recent");
        return pref == null || pref.isBlank() ? "recent" : pref;
    }

    public int minQueryLength() {
        if (policyRoot == null || !searchVerifyEnabled) {
            return 2;
        }
        return policyRoot.path("search").path("minQueryLength").asInt(2);
    }

    public int minTokenLength() {
        if (policyRoot == null || !searchVerifyEnabled) {
            return 2;
        }
        return policyRoot.path("search").path("minTokenLength").asInt(2);
    }

    public JsonNode evidencePolicy() {
        if (policyRoot == null) {
            return null;
        }
        return policyRoot.path("evidence");
    }

    public double dedupeWindowSeconds() {
        JsonNode evidence = evidencePolicy();
        if (evidence == null) {
            return 2.0;
        }
        return evidence.path("dedupeWindowSeconds").asDouble(2.0);
    }
}
