package com.example.userservice.client.stub;

import com.example.userservice.client.ProcessingClient;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class ProcessingClientStub implements ProcessingClient {

    @Override
    public Map<String, Object> getUserJobs(Long userId) {
        return Map.of(
                "source", "processing-service-stub",
                "userId", userId,
                "jobs", List.of(),
                "message", "Not implemented yet");
    }
}
