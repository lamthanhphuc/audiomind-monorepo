package com.example.userservice.controller;

import com.example.userservice.knowledge.SpeakerMemoryService;
import com.example.userservice.security.UserPrincipal;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users/me/speaker-memory")
@RequiredArgsConstructor
public class SpeakerMemoryController {

    private final SpeakerMemoryService speakerMemoryService;

    @GetMapping
    public Map<String, Object> list(Authentication authentication) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return Map.of("items", speakerMemoryService.list(principal.userId()));
    }

    @GetMapping("/suggest")
    public Map<String, Object> suggest(
            Authentication authentication,
            @RequestParam String speakerKey
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return speakerMemoryService.suggest(principal.userId(), speakerKey);
    }

    @PostMapping
    public Map<String, Object> remember(
            Authentication authentication,
            @RequestBody Map<String, Object> body
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        Object meetingId = body.get("meetingId");
        Long parsedMeetingId = meetingId instanceof Number number ? number.longValue() : null;
        return speakerMemoryService.remember(
                principal.userId(),
                String.valueOf(body.getOrDefault("speakerFingerprint", body.get("speakerKey"))),
                String.valueOf(body.get("displayName")),
                parsedMeetingId
        );
    }
}
