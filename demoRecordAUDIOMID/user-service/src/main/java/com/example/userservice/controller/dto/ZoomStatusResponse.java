package com.example.userservice.controller.dto;

import java.util.List;

public record ZoomStatusResponse(
        boolean linked,
        String zoomEmail,
        List<String> grantedScopes
) {
}
