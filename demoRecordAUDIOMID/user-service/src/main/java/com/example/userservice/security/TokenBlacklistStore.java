package com.example.userservice.security;

public interface TokenBlacklistStore {
    void blacklist(String token, long ttlSeconds);
    boolean isBlacklisted(String token);
}
