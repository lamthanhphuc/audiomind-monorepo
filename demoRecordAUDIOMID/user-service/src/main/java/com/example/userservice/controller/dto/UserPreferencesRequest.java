package com.example.userservice.controller.dto;

import com.fasterxml.jackson.annotation.JsonAlias;

public record UserPreferencesRequest(
        @JsonAlias("domainMode") String domain_mode
) {
}
