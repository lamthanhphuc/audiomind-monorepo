package com.example.userservice.controller.dto;

public record GoogleTicketExchangeResponse(
        String token,
        long expiresInSeconds,
        GoogleLoginUserResponse user,
        String redirectAfter
) {
}
