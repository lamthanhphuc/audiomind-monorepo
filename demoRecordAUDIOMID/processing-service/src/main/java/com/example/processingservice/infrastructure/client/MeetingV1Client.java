package com.example.processingservice.infrastructure.client;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

@Component
@RequiredArgsConstructor
public class MeetingV1Client {

    private final RestTemplate restTemplate;

    @Value("${audiomind.meeting-api.base-url}")
    private String meetingApiBaseUrl;

    public void updateResult(String meetingId, String transcript, String summary) {
        Map<String, Object> body = new HashMap<>();
        body.put("transcript", transcript);
        body.put("summary", summary);

        restTemplate.put(
                meetingApiBaseUrl + "/api/v1/meetings/" + meetingId + "/result",
                body
        );
    }
}
