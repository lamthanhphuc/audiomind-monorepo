package com.example.userservice.zoom;

import java.time.Duration;
import java.util.List;

public final class ZoomScopes {

    public static final List<String> LINK = List.of("user:read", "recording:read");

    private ZoomScopes() {
    }
}
