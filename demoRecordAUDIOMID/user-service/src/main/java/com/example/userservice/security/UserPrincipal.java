package com.example.userservice.security;

public record UserPrincipal(Long userId, String username, String role, String plan) {
}
