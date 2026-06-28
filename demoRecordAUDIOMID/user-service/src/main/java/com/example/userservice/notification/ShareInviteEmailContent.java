package com.example.userservice.notification;

public record ShareInviteEmailContent(
        String subject,
        String plainText,
        String htmlBody
) {
}
