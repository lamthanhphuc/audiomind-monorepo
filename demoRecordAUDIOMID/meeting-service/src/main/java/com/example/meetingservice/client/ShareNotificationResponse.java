package com.example.meetingservice.client;

import java.util.List;

public record ShareNotificationResponse(
        boolean sent,
        String channel,
        boolean requiresGmailScope,
        List<String> missingScopes,
        String emailFrom
) {
    public static ShareNotificationResponse skipped() {
        return new ShareNotificationResponse(false, "NONE", false, List.of(), null);
    }
}
