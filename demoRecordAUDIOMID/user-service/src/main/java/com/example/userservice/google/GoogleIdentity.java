package com.example.userservice.google;

public record GoogleIdentity(
        String subject,
        String email,
        boolean emailVerified,
        String displayName,
        String avatarUrl
) {
}
