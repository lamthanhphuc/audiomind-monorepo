package com.example.userservice.controller.dto;

import java.util.List;
import java.util.Map;

public record ZoomRecordingsResponse(
        String from,
        String to,
        List<Map<String, Object>> meetings
) {
}
