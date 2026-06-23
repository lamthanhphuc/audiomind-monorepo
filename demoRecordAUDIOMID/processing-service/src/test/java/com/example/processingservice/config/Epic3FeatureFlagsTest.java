package com.example.processingservice.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class Epic3FeatureFlagsTest {

    @Test
    void defaultsAreFalse() {
        Epic3FeatureFlags flags = new Epic3FeatureFlags();

        assertFalse(flags.isTranscriptQualityEnabled());
        assertFalse(flags.isDomainLexiconEnabled());
        assertFalse(flags.isEvidenceQaEnabled());
        assertFalse(flags.isSearchVerifyEnabled());
        assertFalse(flags.isExportVerifyEnabled());
    }

    @Test
    void settersUpdateFlags() {
        Epic3FeatureFlags flags = new Epic3FeatureFlags();
        flags.setTranscriptQualityEnabled(true);
        flags.setDomainLexiconEnabled(true);
        flags.setEvidenceQaEnabled(true);
        flags.setSearchVerifyEnabled(true);
        flags.setExportVerifyEnabled(true);

        assertTrue(flags.isTranscriptQualityEnabled());
        assertTrue(flags.isDomainLexiconEnabled());
        assertTrue(flags.isEvidenceQaEnabled());
        assertTrue(flags.isSearchVerifyEnabled());
        assertTrue(flags.isExportVerifyEnabled());
    }
}
