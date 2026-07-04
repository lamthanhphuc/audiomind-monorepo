package com.example.userservice.client;

import java.util.Map;

public interface ProcessingClient {
    Map<String, Object> getUserJobs(Long userId, String authorization);

    Map<String, Object> startProcessing(Long meetingId, String language, String authorization);
}
