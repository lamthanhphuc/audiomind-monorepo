package com.example.processingservice.application;

import com.example.processingservice.domain.model.ProcessingJobResult;
import com.example.processingservice.infrastructure.client.AiV1Client;
import com.example.processingservice.infrastructure.client.MeetingV1Client;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.Map;

@Service
@RequiredArgsConstructor
public class ProcessMeetingJobUseCase {

    private final AiV1Client aiV1Client;
    private final MeetingV1Client meetingV1Client;

    public ProcessingJobResult processMeeting(String meetingId) {
        Map<String, Object> aiResult = aiV1Client.process(meetingId);

        String transcript = String.valueOf(aiResult.getOrDefault("transcript", ""));
        String summary = String.valueOf(aiResult.getOrDefault("summary", ""));

        meetingV1Client.updateResult(meetingId, transcript, summary);

        return new ProcessingJobResult(meetingId, "COMPLETED", transcript, summary);
    }
}
