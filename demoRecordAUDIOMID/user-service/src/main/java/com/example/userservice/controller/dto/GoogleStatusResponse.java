package com.example.userservice.controller.dto;

import java.util.List;

public record GoogleStatusResponse(
        boolean linked,
        String googleEmail,
        List<String> grantedScopes,
        List<String> missingScopes
) {
}
