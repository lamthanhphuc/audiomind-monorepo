package com.example.processingservice.config;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * Structural validation for transcript-quality policy JSON (mirrors
 * packages/contracts/transcript-quality-policy.schema.json).
 */
public final class TranscriptQualityPolicyValidator {

    private TranscriptQualityPolicyValidator() {}

    public static boolean isValid(JsonNode root) {
        if (root == null || root.isNull() || !root.isObject()) {
            return false;
        }
        if (!hasNonBlankText(root, "version")) {
            return false;
        }
        if (!isValidTranscript(root.path("transcript"))) {
            return false;
        }
        if (!isValidSearch(root.path("search"))) {
            return false;
        }
        if (!isValidEvidence(root.path("evidence"))) {
            return false;
        }
        if (!isValidExport(root.path("export"))) {
            return false;
        }
        return isValidLexicon(root.path("lexicon"));
    }

    private static boolean isValidTranscript(JsonNode node) {
        return node.isObject()
                && hasNonBlankText(node, "canonicalVersion")
                && node.path("shortSegmentMaxWords").isInt()
                && node.path("shortSegmentMaxWords").asInt() >= 1
                && node.path("mergeMaxGapSeconds").isNumber()
                && node.path("mergeMaxGapSeconds").asDouble() >= 0
                && node.path("displayGroupingEnabled").isBoolean();
    }

    private static boolean isValidSearch(JsonNode node) {
        if (!node.isObject()) {
            return false;
        }
        if (!node.path("minQueryLength").isInt()
                || !node.path("minTokenLength").isInt()
                || !node.path("maxLimit").isInt()
                || !node.path("maxContext").isInt()
                || !node.path("phraseMinLength").isInt()
                || !node.path("maxScanSegments").isInt()) {
            return false;
        }
        String scanPreference = node.path("scanPreference").asText("");
        return "recent".equals(scanPreference) || "oldest".equals(scanPreference) || "score".equals(scanPreference);
    }

    private static boolean isValidEvidence(JsonNode node) {
        return node.isObject()
                && node.path("minScore").isNumber()
                && node.path("minScore").asDouble() >= 0
                && node.path("minScore").asDouble() <= 1
                && node.path("dedupeWindowSeconds").isNumber()
                && node.path("dedupeWindowSeconds").asDouble() >= 0
                && node.path("maxMatchesPerActionItem").isInt()
                && node.path("maxMatchesPerActionItem").asInt() >= 1
                && node.path("speakerBoost").isNumber()
                && node.path("speakerBoost").asDouble() >= 0
                && node.path("positionNormDecay").isNumber()
                && node.path("positionNormDecay").asDouble() >= 0
                && node.path("positionNormDecay").asDouble() <= 1;
    }

    private static boolean isValidExport(JsonNode node) {
        if (!node.isObject() || !node.path("supportedFormats").isArray() || node.path("supportedFormats").isEmpty()) {
            return false;
        }
        String mode = node.path("defaultTranscriptMode").asText("");
        return ("readable".equals(mode) || "raw".equals(mode)) && node.path("includeEvidenceNotes").isBoolean();
    }

    private static boolean isValidLexicon(JsonNode node) {
        return node.isObject()
                && hasNonBlankText(node, "defaultDomainPack")
                && node.path("supportedDomainPacks").isArray()
                && !node.path("supportedDomainPacks").isEmpty()
                && node.path("disabledTerms").isArray();
    }

    private static boolean hasNonBlankText(JsonNode node, String field) {
        return node.hasNonNull(field) && !node.path(field).asText("").isBlank();
    }
}
