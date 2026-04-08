package com.example.userservice.client;

import java.util.Map;

public interface ProcessingClient {
    Map<String, Object> getUserJobs(Long userId);
}
