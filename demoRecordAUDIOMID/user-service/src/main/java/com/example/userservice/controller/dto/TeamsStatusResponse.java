package com.example.userservice.controller.dto;

import java.util.List;

public record TeamsStatusResponse(
        boolean linked,
        String teamsEmail,
        List<String> grantedScopes
) {
}
