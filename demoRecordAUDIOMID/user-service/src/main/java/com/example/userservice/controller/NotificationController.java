package com.example.userservice.controller;

import com.example.userservice.notification.UserNotificationService;
import com.example.userservice.notification.NotificationEventHub;
import com.example.userservice.security.UserPrincipal;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/users/me/notifications")
@RequiredArgsConstructor
public class NotificationController {

    private final UserNotificationService userNotificationService;
    private final NotificationEventHub notificationEventHub;

    @GetMapping
    public Map<String, Object> list(
            Authentication authentication,
            @RequestParam(defaultValue = "false") boolean unreadOnly,
            @RequestParam(defaultValue = "20") int limit
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        List<Map<String, Object>> items = userNotificationService.listNotifications(
                principal.userId(),
                unreadOnly,
                limit
        );
        return Map.of(
                "items", items,
                "unreadCount", userNotificationService.unreadCount(principal.userId())
        );
    }

    @GetMapping("/unread-count")
    public Map<String, Object> unreadCount(Authentication authentication) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return Map.of("unreadCount", userNotificationService.unreadCount(principal.userId()));
    }

    @PatchMapping("/{id}/read")
    public Map<String, Object> markRead(
            Authentication authentication,
            @PathVariable Long id
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return userNotificationService.markRead(principal.userId(), id);
    }

    @PostMapping("/read-all")
    public Map<String, Object> markAllRead(Authentication authentication) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        int updated = userNotificationService.markAllRead(principal.userId());
        return Map.of("updated", updated, "unreadCount", 0);
    }

    @GetMapping(value = "/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(Authentication authentication) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return notificationEventHub.connect(principal.userId());
    }
}
