package com.example.userservice.controller.dto;

public record AuthResponse(Long userId, String accessToken, long expiresInSeconds) {
}
