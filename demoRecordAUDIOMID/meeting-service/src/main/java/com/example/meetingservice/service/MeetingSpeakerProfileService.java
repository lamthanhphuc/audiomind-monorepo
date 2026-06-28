package com.example.meetingservice.service;

import com.example.meetingservice.entity.MeetingSpeakerProfile;
import com.example.meetingservice.repository.MeetingSpeakerProfileRepository;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.NoSuchElementException;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class MeetingSpeakerProfileService {

    private final MeetingSpeakerProfileRepository repository;
    private final MeetingService meetingService;

    public List<Map<String, Object>> listProfiles(Long meetingId, Long userId) {
        assertMeetingAccess(meetingId, userId);
        return repository.findByMeetingIdOrderBySpeakerKeyAsc(meetingId).stream()
                .map(this::toView)
                .toList();
    }

    public List<Map<String, Object>> upsertProfiles(
            Long meetingId,
            Long userId,
            List<Map<String, Object>> profiles
    ) {
        assertMeetingAccess(meetingId, userId);
        if (profiles == null || profiles.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "profiles is required");
        }
        List<Map<String, Object>> saved = new ArrayList<>();
        for (Map<String, Object> profile : profiles) {
            String speakerKey = normalizeSpeakerKey(stringValue(profile.get("speakerKey"), profile.get("speaker_key")));
            String displayName = stringValue(profile.get("displayName"), profile.get("display_name")).trim();
            if (!StringUtils.hasText(speakerKey) || !StringUtils.hasText(displayName)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "speakerKey and displayName are required");
            }
            MeetingSpeakerProfile entity = repository.findByMeetingIdAndSpeakerKey(meetingId, speakerKey)
                    .orElseGet(MeetingSpeakerProfile::new);
            entity.setMeetingId(meetingId);
            entity.setSpeakerKey(speakerKey);
            entity.setDisplayName(displayName);
            entity.setColor(stringValue(profile.get("color")));
            entity.setAvatarUrl(stringValue(profile.get("avatarUrl"), profile.get("avatar_url")));
            if (entity.getCreatedByUserId() == null) {
                entity.setCreatedByUserId(userId);
            }
            entity.setUpdatedAt(LocalDateTime.now());
            saved.add(toView(repository.save(entity)));
        }
        return saved;
    }

    public Map<String, Object> deleteProfile(Long meetingId, Long userId, String speakerKey) {
        assertMeetingAccess(meetingId, userId);
        String normalized = normalizeSpeakerKey(speakerKey);
        repository.deleteByMeetingIdAndSpeakerKey(meetingId, normalized);
        return Map.of("deleted", true, "speakerKey", normalized);
    }

    private void assertMeetingAccess(Long meetingId, Long userId) {
        try {
            meetingService.findByIdForUser(meetingId, userId);
        } catch (NoSuchElementException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Meeting not found");
        }
    }

    private Map<String, Object> toView(MeetingSpeakerProfile profile) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", profile.getId());
        view.put("meetingId", profile.getMeetingId());
        view.put("speakerKey", profile.getSpeakerKey());
        view.put("displayName", profile.getDisplayName());
        if (StringUtils.hasText(profile.getColor())) {
            view.put("color", profile.getColor());
        }
        if (StringUtils.hasText(profile.getAvatarUrl())) {
            view.put("avatarUrl", profile.getAvatarUrl());
        }
        view.put("updatedAt", profile.getUpdatedAt() == null ? null : profile.getUpdatedAt().toString());
        return view;
    }

    private static String normalizeSpeakerKey(String speakerKey) {
        if (!StringUtils.hasText(speakerKey)) {
            return "";
        }
        return speakerKey.trim().replaceAll("\\s+", " ").toUpperCase(Locale.ROOT);
    }

    private static String stringValue(Object... values) {
        if (values == null) {
            return "";
        }
        for (Object value : values) {
            if (value != null && StringUtils.hasText(String.valueOf(value))) {
                return String.valueOf(value).trim();
            }
        }
        return "";
    }
}
