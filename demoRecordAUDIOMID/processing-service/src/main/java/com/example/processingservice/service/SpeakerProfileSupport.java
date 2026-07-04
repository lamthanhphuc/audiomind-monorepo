package com.example.processingservice.service;

import com.example.processingservice.client.MeetingServiceClient;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

@Component
@RequiredArgsConstructor
public class SpeakerProfileSupport {

    private final MeetingServiceClient meetingServiceClient;

    public Map<String, String> loadDisplayNames(Long meetingId, String traceId, String authorization) {
        if (!StringUtils.hasText(authorization) || meetingId == null) {
            return Map.of();
        }
        try {
            Map<String, Object> response = meetingServiceClient.getSpeakerProfiles(meetingId, traceId, authorization);
            Object profiles = response.get("profiles");
            if (!(profiles instanceof List<?> list)) {
                return Map.of();
            }
            Map<String, String> displayNames = new HashMap<>();
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> profile)) {
                    continue;
                }
                String speakerKey = normalizeKey(profile.get("speakerKey"), profile.get("speaker_key"));
                String displayName = stringValue(profile.get("displayName"), profile.get("display_name"));
                if (StringUtils.hasText(speakerKey) && StringUtils.hasText(displayName)) {
                    displayNames.put(speakerKey, displayName);
                }
            }
            return displayNames;
        } catch (Exception ignored) {
            return Map.of();
        }
    }

    public List<Map<String, Object>> applyDisplayNames(
            List<Map<String, Object>> rows,
            Map<String, String> displayNames
    ) {
        if (rows == null || rows.isEmpty() || displayNames == null || displayNames.isEmpty()) {
            return rows;
        }
        List<Map<String, Object>> updated = new ArrayList<>(rows.size());
        for (Map<String, Object> row : rows) {
            if (row == null) {
                continue;
            }
            Map<String, Object> copy = new HashMap<>(row);
            String speakerKey = normalizeKey(copy.get("speaker"));
            String displayName = displayNames.get(speakerKey);
            if (StringUtils.hasText(displayName)) {
                copy.put("stableSpeaker", speakerKey);
                copy.put("displaySpeaker", displayName);
                copy.put("speaker", displayName);
            }
            updated.add(copy);
        }
        return updated;
    }

    private static String normalizeKey(Object... values) {
        for (Object value : values) {
            if (value != null && StringUtils.hasText(String.valueOf(value))) {
                return String.valueOf(value).trim().replaceAll("\\s+", " ").toUpperCase(Locale.ROOT);
            }
        }
        return "";
    }

    private static String stringValue(Object... values) {
        for (Object value : values) {
            if (value != null && StringUtils.hasText(String.valueOf(value))) {
                return String.valueOf(value).trim();
            }
        }
        return "";
    }
}
