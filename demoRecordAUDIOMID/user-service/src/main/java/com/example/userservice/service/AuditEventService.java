package com.example.userservice.service;

import com.example.userservice.entity.AuditEvent;
import com.example.userservice.repository.AuditEventRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class AuditEventService {

    private final AuditEventRepository auditEventRepository;
    private final ObjectMapper objectMapper;

    @Transactional
    public AuditEvent record(Long actorUserId, String eventType, String targetType, String targetId, String summary) {
        return record(actorUserId, eventType, targetType, targetId, summary, Map.of());
    }

    @Transactional
    public AuditEvent record(
            Long actorUserId,
            String eventType,
            String targetType,
            String targetId,
            String summary,
            Map<String, Object> metadata
    ) {
        AuditEvent event = new AuditEvent();
        event.setActorUserId(actorUserId);
        event.setEventType(safe(eventType, "UNKNOWN", 80));
        event.setTargetType(safe(targetType, null, 80));
        event.setTargetId(safe(targetId, null, 120));
        event.setSummary(safe(summary, event.getEventType(), 500));
        event.setMetadataJson(writeMetadata(metadata));
        event.setCreatedAt(Instant.now());
        return auditEventRepository.save(event);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> list(Long actorUserId, String eventType, Instant from, Instant to, int limit) {
        int safeLimit = Math.max(1, Math.min(limit, 200));
        Instant resolvedTo = to == null ? Instant.now() : to;
        Instant resolvedFrom = from == null ? resolvedTo.minus(java.time.Duration.ofDays(30)) : from;
        String normalizedEventType = eventType == null || eventType.isBlank() ? null : eventType.trim().toUpperCase();
        PageRequest page = PageRequest.of(0, safeLimit);
        List<AuditEvent> events;
        if (actorUserId != null && normalizedEventType != null) {
            events = auditEventRepository.findByActorUserIdAndEventTypeAndCreatedAtBetweenOrderByCreatedAtDesc(
                    actorUserId,
                    normalizedEventType,
                    resolvedFrom,
                    resolvedTo,
                    page);
        } else if (actorUserId != null) {
            events = auditEventRepository.findByActorUserIdAndCreatedAtBetweenOrderByCreatedAtDesc(
                    actorUserId,
                    resolvedFrom,
                    resolvedTo,
                    page);
        } else if (normalizedEventType != null) {
            events = auditEventRepository.findByEventTypeAndCreatedAtBetweenOrderByCreatedAtDesc(
                    normalizedEventType,
                    resolvedFrom,
                    resolvedTo,
                    page);
        } else {
            events = auditEventRepository.findByCreatedAtBetweenOrderByCreatedAtDesc(
                    resolvedFrom,
                    resolvedTo,
                    page);
        }
        return events.stream().map(this::toView).toList();
    }

    public Map<String, Object> toView(AuditEvent event) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", event.getId());
        view.put("actorUserId", event.getActorUserId());
        view.put("eventType", event.getEventType());
        view.put("targetType", event.getTargetType());
        view.put("targetId", event.getTargetId());
        view.put("summary", event.getSummary());
        view.put("metadata", readMetadata(event.getMetadataJson()));
        view.put("createdAt", event.getCreatedAt() == null ? null : event.getCreatedAt().toString());
        return view;
    }

    private String writeMetadata(Map<String, Object> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            return "{}";
        }
        try {
            return objectMapper.writeValueAsString(metadata);
        } catch (Exception ex) {
            return "{}";
        }
    }

    private Map<String, Object> readMetadata(String raw) {
        if (raw == null || raw.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(raw, new com.fasterxml.jackson.core.type.TypeReference<>() {});
        } catch (Exception ex) {
            return Map.of();
        }
    }

    private static String safe(String value, String fallback, int maxLength) {
        String resolved = value == null || value.isBlank() ? fallback : value.trim();
        if (resolved == null) {
            return null;
        }
        return resolved.length() <= maxLength ? resolved : resolved.substring(0, maxLength);
    }
}
