package com.example.processingservice.client;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class AIServiceClient {

    private final RestTemplate restTemplate;

    @Value("${ai.service.url}")
    private String aiUrl;

    public Map<String, Object> processAudio(Long meetingId, String audioPath) {
        return processAudio(meetingId, audioPath, null, null);
    }

    public Map<String, Object> processAudio(
            Long meetingId,
            String audioPath,
            String topic,
            List<String> glossaryTerms) {

        Map<String, Object> request = new HashMap<>();

        request.put("meeting_id", meetingId);
        request.put("audio_path", audioPath);

        if (topic != null && !topic.isBlank()) {
            request.put("topic", topic);
        }

        if (glossaryTerms != null && !glossaryTerms.isEmpty()) {
            request.put("glossary_terms", glossaryTerms);
        }

        ResponseEntity<Map> response =
                restTemplate.postForEntity(
                        aiUrl + "/api/process",
                        request,
                        Map.class
                );

        return response.getBody();
    }

    public Map<String, Object> getTranscript(Long meetingId) {
        return restTemplate.getForObject(
                aiUrl + "/api/meeting/" + meetingId + "/transcript",
                Map.class
        );
    }

    public Map<String, Object> getAnalysis(Long meetingId) {
        return restTemplate.getForObject(
                aiUrl + "/api/meeting/" + meetingId + "/analysis",
                Map.class
        );
    }
}