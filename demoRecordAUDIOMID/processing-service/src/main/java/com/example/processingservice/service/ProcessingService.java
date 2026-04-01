package com.example.processingservice.service;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

@Service
@RequiredArgsConstructor
public class ProcessingService {

    private final AIServiceClient aiServiceClient;
    private final MeetingServiceClient meetingServiceClient;

    private final Map<Long, String> statusByMeeting = new ConcurrentHashMap<>();
    private final Map<Long, String> errorByMeeting = new ConcurrentHashMap<>();
    private final Map<Long, LocalDateTime> updatedAtByMeeting = new ConcurrentHashMap<>();

    public Map<String, Object> startProcessing(Long meetingId) {
        return startProcessing(meetingId, null, null);
    }

    public Map<String, Object> startProcessing(Long meetingId, String topic, List<String> glossaryTerms) {
        statusByMeeting.put(meetingId, "PENDING");
        errorByMeeting.remove(meetingId);
        updatedAtByMeeting.put(meetingId, LocalDateTime.now());

        CompletableFuture.runAsync(() -> {
            try {
                statusByMeeting.put(meetingId, "RUNNING");
                updatedAtByMeeting.put(meetingId, LocalDateTime.now());

                processMeeting(meetingId, topic, glossaryTerms);

                statusByMeeting.put(meetingId, "DONE");
                updatedAtByMeeting.put(meetingId, LocalDateTime.now());
            } catch (Exception e) {
                statusByMeeting.put(meetingId, "FAILED");
                errorByMeeting.put(meetingId, e.getMessage());
                updatedAtByMeeting.put(meetingId, LocalDateTime.now());
            }
        });

        return getProcessingStatus(meetingId);
    }

    public Map<String, Object> processMeeting(Long meetingId, String topic, List<String> glossaryTerms) {
        Map<String, Object> meeting = meetingServiceClient.getMeetingById(meetingId);
        Object audioPathObj = meeting.get("audioPath");

        if (audioPathObj == null || String.valueOf(audioPathObj).isBlank()) {
            throw new IllegalArgumentException("Meeting has no audioPath: " + meetingId);
        }

        return aiServiceClient.processAudio(
            meetingId,
            String.valueOf(audioPathObj),
            topic,
            glossaryTerms
        );
    }

    public Map<String, Object> getProcessingStatus(Long meetingId) {
        Map<String, Object> result = new HashMap<>();
        result.put("meetingId", meetingId);
        result.put("status", statusByMeeting.getOrDefault(meetingId, "NOT_FOUND"));
        result.put("error", errorByMeeting.get(meetingId));
        result.put("updatedAt", updatedAtByMeeting.get(meetingId));
        return result;
    }

    public Map<String, Object> getTranscript(Long meetingId) {
        return aiServiceClient.getTranscript(meetingId);
    }

    public Map<String, Object> getAnalysis(Long meetingId) {
        return aiServiceClient.getAnalysis(meetingId);
    }
}
