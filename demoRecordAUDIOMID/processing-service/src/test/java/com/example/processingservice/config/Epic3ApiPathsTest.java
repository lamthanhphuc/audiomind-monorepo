package com.example.processingservice.config;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class Epic3ApiPathsTest {

    @Test
    void transcriptQualityConfigPath_matchesSecurityPermitAllTarget() {
        assertEquals("/api/config/transcript-quality", Epic3ApiPaths.TRANSCRIPT_QUALITY_CONFIG);
    }
}
