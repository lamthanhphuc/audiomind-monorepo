package com.example.processingservice.service;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.controller.dto.ProcessingStatusResponse;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
}
