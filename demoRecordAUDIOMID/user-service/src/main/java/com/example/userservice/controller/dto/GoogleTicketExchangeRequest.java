package com.example.userservice.controller.dto;

import jakarta.validation.constraints.NotBlank;

public record GoogleTicketExchangeRequest(@NotBlank String ticket) {
}
