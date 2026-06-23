package com.example.processingservice.config;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

class TranscriptQualityPolicyValidatorTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void acceptsValidPolicyShape() {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("version", "1.0.0");

        ObjectNode transcript = root.putObject("transcript");
        transcript.put("canonicalVersion", "canonical-transcript-v2");
        transcript.put("shortSegmentMaxWords", 3);
        transcript.put("mergeMaxGapSeconds", 5);
        transcript.put("displayGroupingEnabled", true);

        ObjectNode search = root.putObject("search");
        search.put("minQueryLength", 2);
        search.put("minTokenLength", 2);
        search.put("maxLimit", 50);
        search.put("maxContext", 3);
        search.put("phraseMinLength", 4);
        search.put("maxScanSegments", 2000);
        search.put("scanPreference", "recent");

        ObjectNode evidence = root.putObject("evidence");
        evidence.put("minScore", 0.35);
        evidence.put("dedupeWindowSeconds", 2.0);
        evidence.put("maxMatchesPerActionItem", 1);
        evidence.put("speakerBoost", 1.1);
        evidence.put("positionNormDecay", 0.5);

        ObjectNode export = root.putObject("export");
        export.putArray("supportedFormats").add("txt");
        export.put("defaultTranscriptMode", "readable");
        export.put("includeEvidenceNotes", true);

        ObjectNode lexicon = root.putObject("lexicon");
        lexicon.put("defaultDomainPack", "general");
        lexicon.putArray("supportedDomainPacks").add("general");
        lexicon.putArray("disabledTerms");

        assertTrue(TranscriptQualityPolicyValidator.isValid(root));
    }

    @Test
    void rejectsPolicyMissingEvidenceSection() throws Exception {
        try (var input = getClass().getResourceAsStream("/invalid-transcript-quality-policy.json")) {
            assertFalse(TranscriptQualityPolicyValidator.isValid(objectMapper.readTree(input)));
        }
    }
}
