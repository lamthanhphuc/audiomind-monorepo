package com.example.userservice.google;

import java.time.Instant;

public record GoogleLoginTicket(Long userId, String redirectAfter, Instant createdAt) {
}
