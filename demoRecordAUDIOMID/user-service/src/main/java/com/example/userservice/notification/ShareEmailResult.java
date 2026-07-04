package com.example.userservice.notification;

import java.util.List;

public record ShareEmailResult(
        boolean sent,
        String channel,
        boolean requiresGmailScope,
        List<String> missingScopes,
        String gmailMessageId
) {
    public static ShareEmailResult sent(
            String channel,
            boolean requiresGmailScope,
            List<String> missingScopes,
            String gmailMessageId
    ) {
        return new ShareEmailResult(true, channel, requiresGmailScope, List.copyOf(missingScopes), gmailMessageId);
    }

    public static ShareEmailResult skipped(boolean requiresGmailScope, List<String> missingScopes) {
        return new ShareEmailResult(false, "NONE", requiresGmailScope, List.copyOf(missingScopes), null);
    }
}
