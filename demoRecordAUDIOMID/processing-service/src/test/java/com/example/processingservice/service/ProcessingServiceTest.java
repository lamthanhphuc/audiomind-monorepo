package com.example.processingservice.service;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.controller.dto.ProcessingStatusResponse;
import io.micrometer.core.instrument.Gauge;
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
import org.springframework.http.HttpStatus;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
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
    private SimpleMeterRegistry meterRegistry;
    private static final String AUTH_HEADER = "Bearer test-token";

    @BeforeEach
    void setUp() {
        meterRegistry = new SimpleMeterRegistry();
        processingService = new ProcessingService(
                aiServiceClient,
                meetingServiceClient,
                jobStateStore,
            meterRegistry);
        processingService.initMetrics();

        when(meetingServiceClient.getMeetingById(anyLong(), anyString(), anyString()))
            .thenReturn(Map.of("id", 1L));
    }

    @Test
    void getProcessingStatus_shouldReturnNotFoundWhenStateMissing() {
        when(jobStateStore.getJobState(101L)).thenReturn(Optional.empty());

        ProcessingStatusResponse response = processingService.getProcessingStatus(101L, "trace-1", AUTH_HEADER);

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

        ProcessingStatusResponse response = processingService.getProcessingStatus(202L, "trace-2", AUTH_HEADER);

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

        ProcessingStatusResponse response = processingService.getProcessingStatus(303L, "trace-3", AUTH_HEADER);

        assertEquals("RUNNING", response.status());
        assertEquals(100, response.progress());
        assertEquals("unknown", response.stage());
    }

    @Test
    void getTranscript_shouldReturnNotFoundWhenStateMissing() {
        when(jobStateStore.getJobState(404L)).thenReturn(Optional.empty());

        Map<String, Object> response = processingService.getTranscript(404L, "trace-4", AUTH_HEADER);

        assertEquals("NOT_FOUND", response.get("status"));
        assertTrue(response.get("transcripts") instanceof List<?>);
        assertEquals(0, ((List<?>) response.get("transcripts")).size());
    }

    @Test
    void getTranscript_shouldReturnBatchTranscriptWhenAvailable() {
        Map<String, Object> transcriptRow = new HashMap<>();
        transcriptRow.put("speaker", "SPEAKER_00");
        transcriptRow.put("text", "batch transcript");
        transcriptRow.put("start_time", 1.25d);
        transcriptRow.put("end_time", 2.75d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(transcriptRow)));

        when(jobStateStore.getJobState(777L)).thenReturn(Optional.of(state));

        Map<String, Object> response = processingService.getTranscript(777L, "trace-batch", AUTH_HEADER);

        assertEquals("COMPLETED", response.get("status"));
        List<?> transcripts = (List<?>) response.get("transcripts");
        assertEquals(1, transcripts.size());
        Map<?, ?> row = (Map<?, ?>) transcripts.get(0);
        assertEquals("batch transcript", row.get("text"));
        assertEquals(1.25d, row.get("start_time"));

        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
    }

    @Test
    void getTranscript_shouldFallbackToAiWhenJobStateMissing() {
        when(jobStateStore.getJobState(888L)).thenReturn(Optional.empty());
        when(aiServiceClient.getTranscript(888L, "trace-fallback")).thenReturn(Map.of(
                "meeting_id", 888L,
                "transcripts", List.of(
                        Map.of(
                                "speaker", "SPEAKER_00",
                                "text", "first row",
                                "start_time", 0.0d,
                                "end_time", 3.5d,
                                "segment_id", "seg-1",
                                "is_final", true
                        ),
                        Map.of(
                                "speaker", "SPEAKER_01",
                                "text", "second row",
                                "start_time", 3.5d,
                                "end_time", 7.2d,
                                "segment_id", "seg-2",
                                "is_final", true
                        )
                )
        ));

        Map<String, Object> response = processingService.getTranscript(888L, "trace-fallback", AUTH_HEADER);

        assertEquals("COMPLETED", response.get("status"));
        List<?> transcripts = (List<?>) response.get("transcripts");
        assertEquals(2, transcripts.size());

        Map<?, ?> first = (Map<?, ?>) transcripts.get(0);
        assertEquals("first row", first.get("text"));
        assertEquals(0.0d, first.get("start_time"));
        assertEquals(3.5d, first.get("end_time"));
        assertEquals("seg-1", first.get("segment_id"));
        assertEquals(true, first.get("is_final"));

        Map<?, ?> second = (Map<?, ?>) transcripts.get(1);
        assertEquals("second row", second.get("text"));
        assertEquals(3.5d, second.get("start_time"));
        assertEquals(7.2d, second.get("end_time"));
        assertEquals("seg-2", second.get("segment_id"));
    }

    @Test
    void getTranscript_shouldFallbackToAiWhenJobStateTranscriptEmpty() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of()));
        when(jobStateStore.getJobState(889L)).thenReturn(Optional.of(state));
        when(aiServiceClient.getTranscript(889L, "trace-empty-state")).thenReturn(Map.of(
                "meeting_id", 889L,
                "transcripts", List.of(
                        Map.of(
                                "speaker", "SPEAKER_00",
                                "text", "hydrated row",
                                "start_time", 1.0d,
                                "end_time", 2.0d
                        )
                )
        ));

        Map<String, Object> response = processingService.getTranscript(889L, "trace-empty-state", AUTH_HEADER);

        List<?> transcripts = (List<?>) response.get("transcripts");
        assertEquals(1, transcripts.size());
        assertEquals("COMPLETED", response.get("status"));
        Map<?, ?> row = (Map<?, ?>) transcripts.get(0);
        assertEquals("hydrated row", row.get("text"));
    }

    @Test
    void getTranscript_shouldReturnEmptyWhenAiFallbackReturnsNoFragments() {
        when(jobStateStore.getJobState(890L)).thenReturn(Optional.empty());
        when(aiServiceClient.getTranscript(890L, "trace-no-fragments")).thenReturn(Map.of(
                "meeting_id", 890L,
                "transcripts", List.of()
        ));

        Map<String, Object> response = processingService.getTranscript(890L, "trace-no-fragments", AUTH_HEADER);

        assertEquals("NOT_FOUND", response.get("status"));
        assertTrue(response.get("transcripts") instanceof List<?>);
        assertEquals(0, ((List<?>) response.get("transcripts")).size());
    }

    @Test
    void getTranscript_shouldReturnEmptyWhenAiFallbackReturns404() {
        when(jobStateStore.getJobState(891L)).thenReturn(Optional.empty());
        when(aiServiceClient.getTranscript(891L, "trace-ai-404"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

        Map<String, Object> response = processingService.getTranscript(891L, "trace-ai-404", AUTH_HEADER);

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

        Map<String, Object> response = processingService.getAnalysis(505L, "trace-5", AUTH_HEADER);

        assertEquals("QUEUED", response.get("status"));
        assertEquals("ok", response.get("summary"));
        assertEquals("positive", response.get("sentiment"));
    }

    @Test
    void getProcessingStatus_shouldTrackRunningGaugeByActiveJobs() {
        Map<String, Object> runningA = new HashMap<>();
        runningA.put("status", "RUNNING");
        runningA.put("updatedAt", "2026-04-09T00:00:00Z");

        Map<String, Object> runningB = new HashMap<>();
        runningB.put("status", "RUNNING");
        runningB.put("updatedAt", "2026-04-09T00:01:00Z");

        Map<String, Object> completedA = new HashMap<>();
        completedA.put("status", "COMPLETED");
        completedA.put("createdAt", "2026-04-09T00:00:00Z");
        completedA.put("updatedAt", "2026-04-09T00:02:00Z");

        when(jobStateStore.getJobState(1L)).thenReturn(Optional.of(runningA), Optional.of(completedA));
        when(jobStateStore.getJobState(2L)).thenReturn(Optional.of(runningB));

        processingService.getProcessingStatus(1L, "trace-a", AUTH_HEADER);
        processingService.getProcessingStatus(2L, "trace-b", AUTH_HEADER);
        processingService.getProcessingStatus(1L, "trace-c", AUTH_HEADER);

        Gauge gauge = meterRegistry.find("jobs_running").gauge();
        assertEquals(1.0, gauge == null ? 0.0 : gauge.value());
    }

    @Test
    void getTranscript_shouldRejectForbiddenMeetingAccess() {
        when(meetingServiceClient.getMeetingById(909L, "trace-9", AUTH_HEADER))
                .thenThrow(new HttpClientErrorException(HttpStatus.FORBIDDEN));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.getTranscript(909L, "trace-9", AUTH_HEADER)
        );

        assertEquals(HttpStatus.FORBIDDEN, ex.getStatusCode());
    }

    @Test
    void startProcessing_shouldMapAiService503ToServiceUnavailable() {
        when(jobStateStore.claimIdempotency("legacy-meeting:1001", 1001L))
                .thenReturn(new JobStateStore.IdempotencyClaim(1001L, true));
        when(meetingServiceClient.getMeetingById(1001L, "trace-1001", AUTH_HEADER))
                .thenReturn(Map.of("id", 1001L, "audioPath", "/app/uploads/a.wav"));
        when(aiServiceClient.processAudio(1001L, "/app/uploads/a.wav", "legacy-meeting:1001", null, null, "vi", "trace-1001", AUTH_HEADER))
                .thenThrow(new HttpClientErrorException(HttpStatus.SERVICE_UNAVAILABLE, "Service Unavailable"));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.startProcessing(1001L, null, null, null, null, "vi", "trace-1001", AUTH_HEADER)
        );

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatusCode());
        assertEquals("AI service unavailable", ex.getReason());
        verify(jobStateStore).upsertJobState(
                eq(1001L),
                eq("FAILED"),
                eq("legacy-meeting:1001"),
                isNull(),
                anyString(),
                eq("trace-1001")
        );
    }

    @Test
    void startProcessing_shouldKeepSuccessPath() {
        when(jobStateStore.claimIdempotency("legacy-meeting:1002", 1002L))
                .thenReturn(new JobStateStore.IdempotencyClaim(1002L, true));
        when(meetingServiceClient.getMeetingById(1002L, "trace-1002", AUTH_HEADER))
                .thenReturn(Map.of("id", 1002L, "audioPath", "/app/uploads/b.wav"));
        when(aiServiceClient.processAudio(1002L, "/app/uploads/b.wav", "legacy-meeting:1002", null, null, "vi", "trace-1002", AUTH_HEADER))
                .thenReturn(Map.of("status", "queued"));

        Map<String, Object> state = new HashMap<>();
        state.put("status", "QUEUED");
        state.put("progress", 0);
        state.put("stage", "unknown");
        state.put("updatedAt", "2026-05-20T00:00:00Z");
        when(jobStateStore.getJobState(1002L)).thenReturn(Optional.of(state));

        var response = processingService.startProcessing(1002L, null, null, null, null, "vi", "trace-1002", AUTH_HEADER);

        assertEquals(1002L, response.meetingId());
        assertEquals("QUEUED", response.status());
    }

    @Test
    void startProcessing_shouldForwardExplicitUploadLanguageToAiService() {
        when(jobStateStore.claimIdempotency("legacy-meeting:2001", 2001L))
                .thenReturn(new JobStateStore.IdempotencyClaim(2001L, true));
        when(meetingServiceClient.getMeetingById(2001L, "trace-2001", AUTH_HEADER))
                .thenReturn(Map.of("id", 2001L, "audioPath", "/app/uploads/c.wav", "language", "vi"));
        when(aiServiceClient.processAudio(2001L, "/app/uploads/c.wav", "legacy-meeting:2001", null, null, "en", "trace-2001", AUTH_HEADER))
                .thenReturn(Map.of("status", "queued"));
        when(jobStateStore.getJobState(2001L)).thenReturn(Optional.of(Map.of("status", "QUEUED", "progress", 0, "stage", "unknown")));

        processingService.startProcessing(2001L, null, null, null, null, "en", "trace-2001", AUTH_HEADER);

        verify(aiServiceClient).processAudio(2001L, "/app/uploads/c.wav", "legacy-meeting:2001", null, null, "en", "trace-2001", AUTH_HEADER);
    }

    @Test
    void startProcessing_shouldFallbackToMeetingLanguageWhenRequestLanguageMissing() {
        when(jobStateStore.claimIdempotency("legacy-meeting:2002", 2002L))
                .thenReturn(new JobStateStore.IdempotencyClaim(2002L, true));
        when(meetingServiceClient.getMeetingById(2002L, "trace-2002", AUTH_HEADER))
                .thenReturn(Map.of("id", 2002L, "audioPath", "/app/uploads/d.wav", "language", "multi"));
        when(aiServiceClient.processAudio(2002L, "/app/uploads/d.wav", "legacy-meeting:2002", null, null, "multi", "trace-2002", AUTH_HEADER))
                .thenReturn(Map.of("status", "queued"));
        when(jobStateStore.getJobState(2002L)).thenReturn(Optional.of(Map.of("status", "QUEUED", "progress", 0, "stage", "unknown")));

        processingService.startProcessing(2002L, null, null, null, null, null, "trace-2002", AUTH_HEADER);

        verify(aiServiceClient).processAudio(2002L, "/app/uploads/d.wav", "legacy-meeting:2002", null, null, "multi", "trace-2002", AUTH_HEADER);
    }
}
