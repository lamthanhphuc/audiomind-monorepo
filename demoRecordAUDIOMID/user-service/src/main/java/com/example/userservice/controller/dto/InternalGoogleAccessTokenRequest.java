package com.example.userservice.controller.dto;

import java.util.List;

public record InternalGoogleAccessTokenRequest(String callerService, Long userId, List<String> requiredScopes) {
}
