package com.example.userservice.knowledge;

import com.example.userservice.entity.UserKnowledgeNote;
import com.example.userservice.repository.UserKnowledgeNoteRepository;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class KnowledgeNoteService {

    private final UserKnowledgeNoteRepository repository;

    public List<Map<String, Object>> list(Long userId, String query) {
        List<UserKnowledgeNote> notes = StringUtils.hasText(query)
                ? repository.search(userId, query.trim())
                : repository.findTop100ByUserIdOrderByUpdatedAtDesc(userId);
        return notes.stream().map(this::toView).toList();
    }

    public List<Map<String, Object>> listForMeeting(Long userId, Long meetingId) {
        return repository.findByUserIdAndMeetingIdOrderByUpdatedAtDesc(userId, meetingId).stream()
                .map(this::toView)
                .toList();
    }

    public Map<String, Object> create(Long userId, Map<String, Object> payload) {
        String body = stringValue(payload.get("body"));
        if (!StringUtils.hasText(body)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "body is required");
        }
        UserKnowledgeNote note = new UserKnowledgeNote();
        note.setUserId(userId);
        note.setMeetingId(longValue(payload.get("meetingId"), payload.get("meeting_id")));
        note.setTerm(stringValue(payload.get("term")));
        note.setNoteType(stringValue(payload.get("noteType"), payload.get("note_type"), "general"));
        note.setTitle(stringValue(payload.get("title")));
        note.setBody(body);
        LocalDateTime now = LocalDateTime.now();
        note.setCreatedAt(now);
        note.setUpdatedAt(now);
        return toView(repository.save(note));
    }

    public Map<String, Object> update(Long userId, Long noteId, Map<String, Object> payload) {
        UserKnowledgeNote note = repository.findById(noteId)
                .filter(item -> item.getUserId().equals(userId))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Note not found"));
        if (payload.containsKey("body")) {
            String body = stringValue(payload.get("body"));
            if (!StringUtils.hasText(body)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "body cannot be empty");
            }
            note.setBody(body);
        }
        if (payload.containsKey("term")) {
            note.setTerm(stringValue(payload.get("term")));
        }
        if (payload.containsKey("title")) {
            note.setTitle(stringValue(payload.get("title")));
        }
        if (payload.containsKey("noteType") || payload.containsKey("note_type")) {
            note.setNoteType(stringValue(payload.get("noteType"), payload.get("note_type"), note.getNoteType()));
        }
        note.setUpdatedAt(LocalDateTime.now());
        return toView(repository.save(note));
    }

    public Map<String, Object> delete(Long userId, Long noteId) {
        UserKnowledgeNote note = repository.findById(noteId)
                .filter(item -> item.getUserId().equals(userId))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Note not found"));
        repository.delete(note);
        return Map.of("deleted", true, "id", noteId);
    }

    private Map<String, Object> toView(UserKnowledgeNote note) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", note.getId());
        view.put("meetingId", note.getMeetingId());
        view.put("term", note.getTerm());
        view.put("noteType", note.getNoteType());
        view.put("title", note.getTitle());
        view.put("body", note.getBody());
        view.put("createdAt", note.getCreatedAt() == null ? null : note.getCreatedAt().toString());
        view.put("updatedAt", note.getUpdatedAt() == null ? null : note.getUpdatedAt().toString());
        return view;
    }

    private static String stringValue(Object... values) {
        for (Object value : values) {
            if (value != null && StringUtils.hasText(String.valueOf(value))) {
                return String.valueOf(value).trim();
            }
        }
        return values.length > 0 && values[values.length - 1] instanceof String fallback ? fallback : "";
    }

    private static Long longValue(Object... values) {
        for (Object value : values) {
            if (value == null) {
                continue;
            }
            if (value instanceof Number number) {
                return number.longValue();
            }
            try {
                return Long.parseLong(String.valueOf(value));
            } catch (NumberFormatException ignored) {
                // continue
            }
        }
        return null;
    }
}
