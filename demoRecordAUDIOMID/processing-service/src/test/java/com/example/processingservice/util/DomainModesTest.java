package com.example.processingservice.util;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;

import org.junit.jupiter.api.Test;

class DomainModesTest {

    @Test
    void normalize_shouldAcceptKnownDomains() {
        assertEquals("education", DomainModes.normalize("Education"));
        assertEquals("it", DomainModes.normalize("IT"));
        assertEquals("business", DomainModes.normalize(" business "));
        assertEquals("legal", DomainModes.normalize("legal"));
        assertEquals("general", DomainModes.normalize("general"));
    }

    @Test
    void normalize_shouldFallbackSafelyForMissingAndUnknown() {
        assertEquals("general", DomainModes.normalize(null));
        assertEquals("general", DomainModes.normalize(""));
        assertEquals("general", DomainModes.normalize("   "));
        assertEquals("general", DomainModes.normalize("finance"));
    }

    @Test
    void fromAnalysisPayload_shouldReadCamelAndSnakeCase() {
        assertEquals("education", DomainModes.fromAnalysisPayload(Map.of("domainMode", "education")));
        assertEquals("it", DomainModes.fromAnalysisPayload(Map.of("domain_mode", "IT")));
        assertEquals("general", DomainModes.fromAnalysisPayload(Map.of()));
        assertEquals("general", DomainModes.fromAnalysisPayload(null));
    }

    @Test
    void firstNonBlankNormalized_shouldPreferFirstValidCandidate() {
        assertEquals(
                "education",
                DomainModes.firstNonBlankNormalized(null, "", "education", "it")
        );
        assertEquals("general", DomainModes.firstNonBlankNormalized((Object[]) null));
        assertEquals("general", DomainModes.firstNonBlankNormalized(null, " ", "unknown"));
    }

    @Test
    void resolveAnalysisVersions_shouldUseEducationIdentity() {
        DomainModes.AnalysisVersions versions = DomainModes.resolveAnalysisVersions("education");
        assertEquals("education-analysis-v1", versions.promptVersion());
        assertEquals("education-study-v1", versions.schemaVersion());
        assertEquals("education-study-v1", versions.analysisFeatureSet());
    }

    @Test
    void resolveAnalysisVersions_shouldNamespaceNonEducationFeatureSets() {
        DomainModes.AnalysisVersions it = DomainModes.resolveAnalysisVersions("it");
        assertEquals("gemini-business-v2", it.promptVersion());
        assertEquals("gemini-business-v2", it.schemaVersion());
        assertEquals("grouped-action-plan-v1-it", it.analysisFeatureSet());

        DomainModes.AnalysisVersions general = DomainModes.resolveAnalysisVersions(null);
        assertEquals("grouped-action-plan-v1-general", general.analysisFeatureSet());
    }
}
