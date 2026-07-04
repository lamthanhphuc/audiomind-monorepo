package com.example.meetingservice.security;

public record UserPrincipal(Long userId, String username, String role, String plan) {
}
