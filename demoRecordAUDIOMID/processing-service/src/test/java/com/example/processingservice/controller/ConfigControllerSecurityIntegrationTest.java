package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.example.processingservice.config.Epic3ApiPaths;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.TestPropertySource;
import org.springframework.web.client.RestClient;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@TestPropertySource(properties = {
    "JWT_SECRET=test-jwt-secret-with-minimum-32-characters-long",
    "app.security.jwt.secret=test-jwt-secret-with-minimum-32-characters-long",
    "cors.allowed-origins=http://localhost:5173",
    "app.rate-limit.enabled=false"
})
class ConfigControllerSecurityIntegrationTest {

    @LocalServerPort
    private int port;

    @Test
    void transcriptQualityConfig_isPublicWithoutJwt() {
        RestClient client = RestClient.create("http://localhost:" + port);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = client.get()
                .uri(Epic3ApiPaths.TRANSCRIPT_QUALITY_CONFIG)
                .retrieve()
                .body(Map.class);

        assertNotNull(body);
        assertEquals("1.0.0", body.get("version"));
    }
}
