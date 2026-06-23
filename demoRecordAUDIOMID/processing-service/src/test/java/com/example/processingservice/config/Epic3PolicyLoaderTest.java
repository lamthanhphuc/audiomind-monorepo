package com.example.processingservice.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class Epic3PolicyLoaderTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void loadsPrimaryPolicyFromClasspath() {
        Epic3PolicyLoader loader = new Epic3PolicyLoader(objectMapper);

        assertEquals("1.0.0", loader.getPolicy().path("version").asText());
        assertEquals("canonical-transcript-v2", loader.getPolicy().path("transcript").path("canonicalVersion").asText());
        assertEquals(0.35, loader.getPolicy().path("evidence").path("minScore").asDouble(), 0.0001);
        assertNotNull(loader.asMap().get("search"));
    }

    @Test
    void fallsBackToDefaultPolicyWhenPrimaryMissing() {
        Epic3PolicyLoader loader = new Epic3PolicyLoader(
                objectMapper,
                "missing-transcript-quality-policy.json",
                Epic3PolicyLoader.FALLBACK_POLICY_RESOURCE
        );

        assertEquals("1.0.0", loader.getPolicy().path("version").asText());
        assertEquals("recent", loader.getPolicy().path("search").path("scanPreference").asText());
    }

    @Test
    void fallsBackToDefaultPolicyWhenPrimaryFailsSchemaValidation() {
        Epic3PolicyLoader loader = new Epic3PolicyLoader(
                objectMapper,
                "invalid-transcript-quality-policy.json",
                Epic3PolicyLoader.FALLBACK_POLICY_RESOURCE
        );

        assertEquals("1.0.0", loader.getPolicy().path("version").asText());
        assertEquals(0.35, loader.getPolicy().path("evidence").path("minScore").asDouble(), 0.0001);
    }

    @Test
    void usesHardcodedDefaultsWhenPrimaryAndFallbackMissing() {
        Epic3PolicyLoader loader = new Epic3PolicyLoader(
                objectMapper,
                "missing-primary-policy.json",
                "missing-fallback-policy.json"
        );

        assertEquals("1.0.0", loader.getPolicy().path("version").asText());
        assertEquals(1.1, loader.getPolicy().path("evidence").path("speakerBoost").asDouble(), 0.0001);
        assertEquals("general", loader.getPolicy().path("lexicon").path("defaultDomainPack").asText());
    }
}
