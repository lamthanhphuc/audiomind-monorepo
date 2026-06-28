package com.example.userservice.google;

import java.time.Instant;
import java.util.List;

public record GoogleLoginState(
        String mode,
        String nonce,
        String redirectAfter,
        Instant createdAt,
        Long userId,
        List<String> requestedScopes
) {
    public GoogleLoginState(String mode, String nonce, String redirectAfter, Instant createdAt) {
        this(mode, nonce, redirectAfter, createdAt, null, List.of());
    }
}
