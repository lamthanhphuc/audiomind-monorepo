package com.example.userservice.teams;

import java.util.List;

public final class TeamsScopes {

    public static final List<String> LINK = List.of(
            "offline_access",
            "User.Read",
            "OnlineMeetings.Read",
            "OnlineMeetingRecording.Read.All");

    private TeamsScopes() {
    }
}
