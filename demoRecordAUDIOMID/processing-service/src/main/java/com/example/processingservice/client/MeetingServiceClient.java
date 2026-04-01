package com.example.processingservice.client;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.Map;

@Service
@RequiredArgsConstructor
public class MeetingServiceClient {

    private final RestTemplate restTemplate;

    @Value("${meeting.service.url}")
    private String meetingServiceUrl;

    public Map<String, Object> getMeetingById(Long meetingId) {
        return restTemplate.getForObject(
                meetingServiceUrl + "/meetings/" + meetingId,
                Map.class
        );
    }
}
