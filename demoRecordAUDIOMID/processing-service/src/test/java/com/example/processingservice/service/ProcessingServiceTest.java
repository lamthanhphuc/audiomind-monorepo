package com.example.processingservice.service;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.controller.dto.ProcessingStatusResponse;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ProcessingServiceTest {

    @Mock
    private AIServiceClient aiServiceClient;

    @Mock
    private MeetingServiceClient meetingServiceClient;

    @Mock
    private JobStateStore jobStateStore;

    private ProcessingService processingService;

    @BeforeEach
    void setUp() {
        processingService = new ProcessingService(
                aiServiceClient,
                meetingServiceClient,
                jobStateStore,
                new SimpleMeterRegistry());
    }

    @Test
    void getProcessingStatus_shouldReturnNotFoundWhenStateMissing() {
        when(jobStateStore.getJobState(101L)).thenReturn(Optional.empty());

        ProcessingStatusResponse response = processingService.getProcessingStatus(101L, "trace-1");

        assertEquals("NOT_FOUND", response.status());
        assertNull(response.error());
        assertNull(response.updatedAt());
    }

    @Test
    void getProcessingStatus_shouldNormalizePendingToQueued() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "PENDING");
        state.put("updatedAt", "2026-04-08T00:00:00Z");

        when(jobStateStore.getJobState(202L)).thenReturn(Optional.of(state));

        ProcessingStatusResponse response = processingService.getProcessingStatus(202L, "trace-2");

        assertEquals("QUEUED", response.status());
        assertEquals("2026-04-08T00:00:00Z", response.updatedAt());
    }

    @Test
    void getProcessingStatus_shouldClampProgressAndDefaultStage() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "RUNNING");
        state.put("progress", "101");
        state.put("updatedAt", "2026-04-09T00:00:00Z");

        when(jobStateStore.getJobState(303L)).thenReturn(Optional.of(state));

        ProcessingStatusResponse response = processingService.getProcessingStatus(303L, "trace-3");

        assertEquals("RUNNING", response.status());
        assertEquals(100, response.progress());
        assertEquals("unknown", response.stage());
    }

    @Test
    void getTranscript_shouldReturnNotFoundWhenStateMissing() {
        when(jobStateStore.getJobState(404L)).thenReturn(Optional.empty());

        Map<String, Object> response = processingService.getTranscript(404L, "trace-4");

        assertEquals("NOT_FOUND", response.get("status"));
        assertTrue(response.get("transcripts") instanceof List<?>);
        assertEquals(0, ((List<?>) response.get("transcripts")).size());
    }

    @Test
    void getAnalysis_shouldFlattenAnalysisMapAndNormalizeStatus() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "pending");
        state.put("result", Map.of("analysis", Map.of("summary", "ok", "sentiment", "positive")));

        when(jobStateStore.getJobState(505L)).thenReturn(Optional.of(state));

        Map<String, Object> response = processingService.getAnalysis(505L, "trace-5");

        assertEquals("QUEUED", response.get("status"));
        assertEquals("ok", response.get("summary"));
        assertEquals("positive", response.get("sentiment"));
    }
}
