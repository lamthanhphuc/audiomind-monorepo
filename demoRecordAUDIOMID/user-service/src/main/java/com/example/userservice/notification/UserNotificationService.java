package com.example.userservice.notification;

import com.example.userservice.entity.UserNotification;
import com.example.userservice.repository.UserNotificationRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class UserNotificationService {

    public static final String TYPE_MEETING_SHARE_INVITE = "MEETING_SHARE_INVITE";
    public static final String TYPE_JOB_COMPLETED = "JOB_COMPLETED";
    public static final String TYPE_JOB_FAILED = "JOB_FAILED";

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private final UserNotificationRepository notificationRepository;
    private final NotificationEventHub notificationEventHub;

    @Transactional
    public UserNotification createNotification(
            Long userId,
            String type,
            String title,
            String body,
            Map<String, Object> payload
    ) {
        UserNotification notification = new UserNotification();
        notification.setUserId(userId);
        notification.setType(type);
        notification.setTitle(title);
        notification.setBody(body);
        notification.setPayloadJson(serializePayload(payload));
        notification.setCreatedAt(Instant.now());
        UserNotification saved = notificationRepository.save(notification);
        Map<String, Object> view = toView(saved);
        long unread = unreadCount(userId);
        notificationEventHub.publish(userId, view, unread);
        return saved;
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> listNotifications(Long userId, boolean unreadOnly, int limit) {
        List<UserNotification> rows = notificationRepository.findForUser(userId, unreadOnly);
        return rows.stream()
                .limit(Math.max(1, Math.min(limit, 50)))
                .map(this::toView)
                .toList();
    }

    @Transactional(readOnly = true)
    public long unreadCount(Long userId) {
        return notificationRepository.countByUserIdAndReadAtIsNull(userId);
    }

    @Transactional
    public Map<String, Object> markRead(Long userId, Long notificationId) {
        UserNotification notification = notificationRepository.findByIdAndUserId(notificationId, userId)
                .orElseThrow(() -> new NoSuchElementException("Notification not found"));
        if (notification.getReadAt() == null) {
            notification.setReadAt(Instant.now());
            notificationRepository.save(notification);
        }
        return toView(notification);
    }

    @Transactional
    public int markAllRead(Long userId) {
        return notificationRepository.markAllRead(userId, Instant.now());
    }

    private Map<String, Object> toView(UserNotification notification) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", notification.getId());
        view.put("type", notification.getType());
        view.put("title", notification.getTitle());
        view.put("body", notification.getBody());
        view.put("payload", deserializePayload(notification.getPayloadJson()));
        view.put("read", notification.getReadAt() != null);
        view.put("readAt", notification.getReadAt());
        view.put("createdAt", notification.getCreatedAt());
        return view;
    }

    private static String serializePayload(Map<String, Object> payload) {
        if (payload == null || payload.isEmpty()) {
            return null;
        }
        try {
            return OBJECT_MAPPER.writeValueAsString(payload);
        } catch (JsonProcessingException ex) {
            return "{}";
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> deserializePayload(String payloadJson) {
        if (payloadJson == null || payloadJson.isBlank()) {
            return Map.of();
        }
        try {
            return OBJECT_MAPPER.readValue(payloadJson, Map.class);
        } catch (JsonProcessingException ex) {
            return Map.of();
        }
    }
}
