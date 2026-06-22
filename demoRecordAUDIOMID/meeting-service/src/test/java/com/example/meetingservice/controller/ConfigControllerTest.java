package com.example.meetingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.meetingservice.config.UploadValidationPolicy;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class ConfigControllerTest {

    @Test
    void uploadConfig_returnsPolicyValues() {
        ConfigController controller = new ConfigController(new UploadValidationPolicy(new ObjectMapper()));

        var payload = controller.uploadConfig();

        assertEquals(104_857_600L, payload.get("maxUploadBytes"));
        assertTrue(payload.get("allowedExtensions").toString().contains(".mp3"));
    }
}
