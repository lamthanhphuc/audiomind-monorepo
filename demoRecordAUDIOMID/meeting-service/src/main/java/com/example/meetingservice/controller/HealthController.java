package com.example.meetingservice.controller;

import com.example.meetingservice.repository.MeetingRepository;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class HealthController {

    private final MeetingRepository meetingRepository;

    @GetMapping("/health")
    public Map<String, Object> health() {
        return buildPayload("UP", "ok", Map.of());
    }

    @GetMapping("/ready")
    public ResponseEntity<Map<String, Object>> ready() {
        Map<String, String> dependencies = new LinkedHashMap<>();

        try {
            meetingRepository.count();
            dependencies.put("database", "UP");
            return ResponseEntity.ok(buildPayload("UP", "ready", dependencies));
        } catch (Exception ex) {
            dependencies.put("database", "DOWN");
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(buildPayload("DOWN", "not_ready", dependencies));
        }
    }

    private Map<String, Object> buildPayload(
        String status,
        String legacyStatus,
        Map<String, String> dependencies
    ) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("status", status);
        payload.put("service", "meeting-service");
        payload.put("timestamp", Instant.now().toString());
        payload.put("dependencies", dependencies);
        payload.put("legacyStatus", legacyStatus);
        return payload;
    }
}
