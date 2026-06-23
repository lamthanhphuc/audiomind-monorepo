package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.example.processingservice.config.Epic3PolicyLoader;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class ConfigControllerTest {

    @Test
    void transcriptQualityConfig_returnsPolicyValues() {
        Epic3PolicyLoader loader = new Epic3PolicyLoader(new ObjectMapper());
        ConfigController controller = new ConfigController(loader);

        var payload = controller.transcriptQualityConfig();

        assertEquals("1.0.0", payload.get("version"));
        assertNotNull(payload.get("transcript"));
        assertNotNull(payload.get("evidence"));
        @SuppressWarnings("unchecked")
        var evidence = (java.util.Map<String, Object>) payload.get("evidence");
        assertEquals(0.35, ((Number) evidence.get("minScore")).doubleValue(), 0.0001);
    }
}
