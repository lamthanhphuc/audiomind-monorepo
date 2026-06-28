package com.example.meetingservice.client;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Component
@RequiredArgsConstructor
public class TaskReminderClient {

    private final RestTemplate restTemplate = new RestTemplate();

    @Value("${user.service.url}")
    private String userServiceUrl;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    public void sendTaskReminder(
            Long userId,
            Long meetingId,
            Long taskId,
            String meetingTitle,
            String taskTitle,
            String deadline,
            String status
    ) {
        if (internalServiceToken == null || internalServiceToken.isBlank()) {
            return;
        }
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("X-Internal-Service-Token", internalServiceToken);
        var body = java.util.Map.of(
                "userId", userId,
                "meetingId", meetingId,
                "taskId", taskId,
                "meetingTitle", meetingTitle == null ? "" : meetingTitle,
                "taskTitle", taskTitle,
                "deadline", deadline == null ? "" : deadline,
                "status", status == null ? "open" : status
        );
        restTemplate.postForEntity(
                userServiceUrl + "/internal/notifications/task-reminder",
                new HttpEntity<>(body, headers),
                Void.class
        );
    }
}
