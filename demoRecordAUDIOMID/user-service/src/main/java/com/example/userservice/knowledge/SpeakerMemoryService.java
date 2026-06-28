package com.example.userservice.knowledge;

import com.example.userservice.entity.UserSpeakerMemory;
import com.example.userservice.repository.UserSpeakerMemoryRepository;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class SpeakerMemoryService {

    private final UserSpeakerMemoryRepository repository;

    public Map<String, Object> remember(
            Long userId,
            String speakerFingerprint,
            String displayName,
            Long meetingId
    ) {
        String fingerprint = normalizeFingerprint(speakerFingerprint);
        String name = displayName == null ? "" : displayName.trim();
        if (!StringUtils.hasText(fingerprint) || !StringUtils.hasText(name)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "speakerFingerprint and displayName are required");
        }
        UserSpeakerMemory memory = repository.findByUserIdAndSpeakerFingerprint(userId, fingerprint)
                .orElseGet(UserSpeakerMemory::new);
        memory.setUserId(userId);
        memory.setSpeakerFingerprint(fingerprint);
        memory.setDisplayName(name);
        memory.setUsageCount(memory.getId() == null ? 1 : memory.getUsageCount() + 1);
        memory.setLastMeetingId(meetingId);
        memory.setUpdatedAt(LocalDateTime.now());
        return toView(repository.save(memory));
    }

    public Map<String, Object> suggest(Long userId, String speakerFingerprint) {
        String fingerprint = normalizeFingerprint(speakerFingerprint);
        Optional<UserSpeakerMemory> match = repository.findByUserIdAndSpeakerFingerprint(userId, fingerprint);
        if (match.isEmpty()) {
            return Map.of("suggested", false);
        }
        UserSpeakerMemory memory = match.get();
        return Map.of(
                "suggested", true,
                "speakerFingerprint", memory.getSpeakerFingerprint(),
                "displayName", memory.getDisplayName(),
                "usageCount", memory.getUsageCount(),
                "lastMeetingId", memory.getLastMeetingId()
        );
    }

    public List<Map<String, Object>> list(Long userId) {
        return repository.findTop20ByUserIdOrderByUsageCountDescUpdatedAtDesc(userId).stream()
                .map(this::toView)
                .toList();
    }

    private Map<String, Object> toView(UserSpeakerMemory memory) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("speakerFingerprint", memory.getSpeakerFingerprint());
        view.put("displayName", memory.getDisplayName());
        view.put("usageCount", memory.getUsageCount());
        view.put("lastMeetingId", memory.getLastMeetingId());
        view.put("updatedAt", memory.getUpdatedAt() == null ? null : memory.getUpdatedAt().toString());
        return view;
    }

    private static String normalizeFingerprint(String value) {
        if (!StringUtils.hasText(value)) {
            return "";
        }
        return value.trim().replaceAll("\\s+", " ").toUpperCase(Locale.ROOT);
    }
}
