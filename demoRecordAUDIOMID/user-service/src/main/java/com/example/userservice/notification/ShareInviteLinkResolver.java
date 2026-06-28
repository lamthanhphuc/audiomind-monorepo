package com.example.userservice.notification;

import java.util.Locale;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * Resolves public frontend URLs for share-invite emails.
 * Base URL comes from {@code app.notifications.frontend-base-url}, which chains
 * {@code NOTIFICATION_FRONTEND_BASE_URL} → {@code PUBLIC_FRONTEND_ORIGIN} in application.yml.
 */
@Component
@RequiredArgsConstructor
public class ShareInviteLinkResolver {

    private final NotificationProperties notificationProperties;

    public String registerUrl(Long meetingId) {
        if (meetingId == null || meetingId <= 0) {
            throw new IllegalArgumentException("meetingId is required for pending invite register URL");
        }
        return normalizedBaseUrl() + "/register?openMeeting=" + meetingId;
    }

    public String meetingUrl(Long meetingId) {
        return normalizedBaseUrl() + "/?openMeeting=" + meetingId;
    }

    public String normalizedBaseUrl() {
        String base = notificationProperties.getFrontendBaseUrl();
        if (!StringUtils.hasText(base)) {
            return "http://localhost:8080";
        }
        return base.trim().replaceAll("/$", "");
    }

    public boolean isLocalDevBaseUrl() {
        String normalized = normalizedBaseUrl().toLowerCase(Locale.ROOT);
        return normalized.contains("localhost") || normalized.contains("127.0.0.1");
    }
}
