package com.example.userservice.client;

import java.util.Map;

public interface MeetingClient {
    Map<String, Object> getUserMeetings(Long userId, String authorization);

    Map<String, Object> uploadMeeting(String title, byte[] fileBytes, String filename, String language, String authorization);
}
