package com.example.processingservice.integration;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.example.processingservice.config.Epic3FeatureFlags;
import com.example.processingservice.config.Epic3PolicyLoader;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

/**
 * Epic 3 smoke wiring test (epic3-e2e profile semantics without full MockMvc stack).
 */
class Epic3EndToEndIT {

    @Test
    void epic3PolicyAndFlagsLoad() {
        Epic3PolicyLoader loader = new Epic3PolicyLoader(new ObjectMapper());
        Epic3FeatureFlags flags = new Epic3FeatureFlags();

        assertNotNull(loader.getPolicy());
        assertFalse(flags.isTranscriptQualityEnabled());
        assertFalse(flags.isEvidenceQaEnabled());
        assertFalse(flags.isSearchVerifyEnabled());
        assertFalse(flags.isExportVerifyEnabled());
        assertFalse(flags.isDomainLexiconEnabled());
    }
}
