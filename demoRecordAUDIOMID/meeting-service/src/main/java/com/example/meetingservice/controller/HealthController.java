package com.example.meetingservice.controller;

import com.example.meetingservice.repository.MeetingRepository;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class HealthController {

    private final MeetingRepository meetingRepository;

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "ok", "service", "meeting-service");
    }

    @GetMapping("/ready")
    public Map<String, String> ready() {
        meetingRepository.count();
        return Map.of("status", "ready", "service", "meeting-service");
    }
}
