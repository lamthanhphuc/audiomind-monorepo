package com.example.userservice.client;

import java.util.Map;

public interface MeetingClient {
    Map<String, Object> getUserMeetings(Long userId);
}
