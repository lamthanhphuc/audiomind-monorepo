package com.example.processingservice.security;

public record UserPrincipal(Long userId, String username, String role, String plan) {
}
