package com.example.meetingservice.service;

import com.example.meetingservice.entity.MeetingTask;
import com.example.meetingservice.repository.MeetingTaskRepository;
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
public class MeetingTaskService {

    private final MeetingTaskRepository repository;
    private final MeetingService meetingService;

    public List<Map<String, Object>> listTasks(Long meetingId, Long userId) {
        assertMeetingAccess(meetingId, userId);
        return repository.findByMeetingIdOrderByUpdatedAtDesc(meetingId).stream()
                .map(this::toView)
                .toList();
    }

    public Map<String, Object> createTask(Long meetingId, Long userId, Map<String, Object> payload) {
        assertMeetingAccess(meetingId, userId);
        String title = stringValue(payload.get("title"));
        if (!StringUtils.hasText(title)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "title is required");
        }
        MeetingTask task = new MeetingTask();
        task.setMeetingId(meetingId);
        task.setTitle(title);
        task.setOwner(stringValue(payload.get("owner")));
        task.setDeadline(stringValue(payload.get("deadline")));
        task.setPriority(normalizePriority(stringValue(payload.get("priority"), "medium")));
        task.setStatus(normalizeStatus(stringValue(payload.get("status"), "open")));
        task.setSourceKey(stringValue(payload.get("sourceKey"), payload.get("source_key")));
        task.setCreatedByUserId(userId);
        LocalDateTime now = LocalDateTime.now();
        task.setCreatedAt(now);
        task.setUpdatedAt(now);
        return toView(repository.save(task));
    }

    public Map<String, Object> updateTask(Long meetingId, Long userId, Long taskId, Map<String, Object> payload) {
        assertMeetingAccess(meetingId, userId);
        MeetingTask task = repository.findById(taskId)
                .filter(item -> item.getMeetingId().equals(meetingId))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Task not found"));
        if (payload.containsKey("title")) {
            String title = stringValue(payload.get("title"));
            if (!StringUtils.hasText(title)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "title cannot be empty");
            }
            task.setTitle(title);
        }
        if (payload.containsKey("owner")) {
            task.setOwner(stringValue(payload.get("owner")));
        }
        if (payload.containsKey("deadline")) {
            task.setDeadline(stringValue(payload.get("deadline")));
        }
        if (payload.containsKey("priority")) {
            task.setPriority(normalizePriority(stringValue(payload.get("priority"))));
        }
        if (payload.containsKey("status")) {
            task.setStatus(normalizeStatus(stringValue(payload.get("status"))));
        }
        task.setUpdatedAt(LocalDateTime.now());
        return toView(repository.save(task));
    }

    public Map<String, Object> deleteTask(Long meetingId, Long userId, Long taskId) {
        assertMeetingAccess(meetingId, userId);
        MeetingTask task = repository.findById(taskId)
                .filter(item -> item.getMeetingId().equals(meetingId))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Task not found"));
        repository.delete(task);
        return Map.of("deleted", true, "id", taskId);
    }

    public List<Map<String, Object>> seedFromGroupedPlan(
            Long meetingId,
            Long userId,
            Map<String, Object> groupedActionPlan
    ) {
        assertMeetingAccess(meetingId, userId);
        if (groupedActionPlan == null || groupedActionPlan.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "groupedActionPlan is required");
        }
        Object sections = groupedActionPlan.get("sections");
        if (!(sections instanceof List<?> sectionList)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "groupedActionPlan.sections is required");
        }

        List<Map<String, Object>> created = new ArrayList<>();
        for (Object sectionObj : sectionList) {
            if (!(sectionObj instanceof Map<?, ?> section)) {
                continue;
            }
            Object items = section.get("items");
            if (!(items instanceof List<?> itemList)) {
                continue;
            }
            for (Object itemObj : itemList) {
                if (!(itemObj instanceof Map<?, ?> item)) {
                    continue;
                }
                String sourceKey = stringValue(item.get("id"));
                if (StringUtils.hasText(sourceKey)
                        && repository.findByMeetingIdAndSourceKey(meetingId, sourceKey).isPresent()) {
                    continue;
                }
                String title = stringValue(item.get("title"));
                if (!StringUtils.hasText(title)) {
                    continue;
                }
                MeetingTask task = new MeetingTask();
                task.setMeetingId(meetingId);
                task.setTitle(title);
                task.setOwner(stringValue(item.get("owner")));
                task.setDeadline(stringValue(item.get("deadline"), item.get("dueDate")));
                task.setPriority(normalizePriority(stringValue(item.get("priority"), "medium")));
                task.setStatus(normalizeStatus(stringValue(item.get("status"), "open")));
                task.setSourceKey(sourceKey);
                task.setCreatedByUserId(userId);
                LocalDateTime now = LocalDateTime.now();
                task.setCreatedAt(now);
                task.setUpdatedAt(now);
                created.add(toView(repository.save(task)));
            }
        }
        return created;
    }

    private void assertMeetingAccess(Long meetingId, Long userId) {
        try {
            meetingService.findByIdForUser(meetingId, userId);
        } catch (NoSuchElementException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Meeting not found");
        }
    }

    private Map<String, Object> toView(MeetingTask task) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", task.getId());
        view.put("meetingId", task.getMeetingId());
        view.put("title", task.getTitle());
        view.put("owner", task.getOwner());
        view.put("deadline", task.getDeadline());
        view.put("priority", task.getPriority());
        view.put("status", task.getStatus());
        view.put("sourceKey", task.getSourceKey());
        view.put("createdAt", task.getCreatedAt() == null ? null : task.getCreatedAt().toString());
        view.put("updatedAt", task.getUpdatedAt() == null ? null : task.getUpdatedAt().toString());
        return view;
    }

    private static String normalizePriority(String value) {
        String normalized = value == null ? "medium" : value.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "low", "medium", "high" -> normalized;
            default -> "medium";
        };
    }

    private static String normalizeStatus(String value) {
        String normalized = value == null ? "open" : value.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "open", "in_progress", "blocked", "done" -> normalized;
            default -> "open";
        };
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
