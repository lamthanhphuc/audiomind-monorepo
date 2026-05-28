package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.lenient;

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

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.controller.dto.ProcessingStatusResponse;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;

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
        lenient().when(jobStateStore.tryStartAnalysis(anyLong(), anyString(), anyString(), anyString()))
                .thenReturn(new JobStateStore.AnalysisTriggerDecision(
                        true,
                        "RUNNING",
                        "started",
                        "lock-token",
                        0,
                        null
                ));
        lenient().when(jobStateStore.getAnalysisState(anyLong())).thenReturn(Optional.empty());
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
    void getAnalysis_shouldFallbackToAiServiceWhenJobStateMissing() {
        when(jobStateStore.getJobState(606L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(606L, "trace-606")).thenReturn(Map.of(
                "meeting_id", 606L,
                "status", "COMPLETED",
                "summary", "Realtime summary",
                "keywords", List.of("API"),
                "technicalTerms", List.of(
                        Map.of("term", "Webhook", "meaning", "HTTP callback", "category", "integration")
                ),
                "painPoints", List.of(
                        Map.of("title", "Delay", "evidence", "queue lag", "severity", "high")
                ),
                "actionItems", List.of("Scale workers"),
                "domainMode", "it"
        ));

        Map<String, Object> response = processingService.getAnalysis(606L, "trace-606", AUTH_HEADER);

        assertEquals("COMPLETED", response.get("status"));
        assertEquals("Realtime summary", response.get("summary"));
        assertEquals("it", response.get("domainMode"));
        verify(aiServiceClient).getAnalysis(606L, "trace-606");
    }

        @Test
        void getAnalysisReadOnly_shouldReturnStoredAnalysisWithoutLazyTrigger() {
                when(jobStateStore.getJobState(700L)).thenReturn(Optional.empty());
                when(aiServiceClient.getAnalysis(700L, "trace-700")).thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

                Map<String, Object> response = processingService.getAnalysisReadOnly(700L, "trace-700", AUTH_HEADER);

                assertEquals("NOT_FOUND", response.get("status"));
                verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                                eq(700L),
                                anyString(),
                                eq("it"),
                                eq("realtime"),
                                anyString(),
                                eq("trace-700"),
                                eq(AUTH_HEADER)
                );
        }

    @Test
    void getAnalysis_shouldFallbackToAiServiceWhenStateExistsButAnalysisMissing() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "RUNNING");
        state.put("result", Map.of("transcripts", List.of()));
        when(jobStateStore.getJobState(607L)).thenReturn(Optional.of(state));
        when(aiServiceClient.getAnalysis(607L, "trace-607")).thenReturn(Map.of(
                "meeting_id", 607L,
                "status", "COMPLETED",
                "summary", "Ready",
                "domainMode", "it"
        ));

        Map<String, Object> response = processingService.getAnalysis(607L, "trace-607", AUTH_HEADER);

        assertEquals("RUNNING", response.get("status"));
        assertEquals("Ready", response.get("summary"));
        verify(aiServiceClient).getAnalysis(607L, "trace-607");
    }

    @Test
    void getAnalysis_shouldEnqueueRealtimeAnalysisLazilyWhenAiAnalysisIsMissing() {
        when(jobStateStore.getJobState(608L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(608L, "trace-608"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(aiServiceClient.getTranscript(608L, "trace-608")).thenReturn(Map.of(
                "meeting_id", 608L,
                "transcripts", List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "lazy transcript row")
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(608L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                eq("trace-608"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of("status", "completed"));

        Map<String, Object> response = processingService.getAnalysis(608L, "trace-608", AUTH_HEADER);

        assertEquals("NOT_FOUND", response.get("status"));
        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(608L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                eq("trace-608"),
                eq(AUTH_HEADER)
        );
        verify(jobStateStore, timeout(1000)).markAnalysisCompleted(
                eq(608L),
                anyString(),
                eq("get_analysis_lazy"),
                eq("processing_service_lazy_poll"),
                eq("lock-token")
        );
    }

    @Test
    void getAnalysis_shouldNotEnqueueRealtimeAnalysisRepeatedlyWhileInProgress() throws Exception {
        when(jobStateStore.getJobState(609L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(609L, "trace-609"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(aiServiceClient.getTranscript(609L, "trace-609")).thenReturn(Map.of(
                "meeting_id", 609L,
                "transcripts", List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "same transcript")
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(609L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                eq("trace-609"),
                eq(AUTH_HEADER)
        )).thenAnswer(invocation -> {
            Thread.sleep(150);
            return Map.of("status", "completed");
        });
        when(jobStateStore.tryStartAnalysis(eq(609L), anyString(), anyString(), anyString()))
                .thenReturn(
                        new JobStateStore.AnalysisTriggerDecision(
                                true,
                                "RUNNING",
                                "started",
                                "lock-token-609",
                                0,
                                null
                        ),
                        new JobStateStore.AnalysisTriggerDecision(
                                false,
                                "RUNNING",
                                "in_progress",
                                null,
                                10,
                                null
                        )
                );

        processingService.getAnalysis(609L, "trace-609", AUTH_HEADER);
        processingService.getAnalysis(609L, "trace-609", AUTH_HEADER);

        verify(aiServiceClient, timeout(1500).times(1)).analyzeRealtimeTranscript(
                eq(609L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                eq("trace-609"),
                eq(AUTH_HEADER)
        );
    }

    @Test
    void getAnalysis_shouldSkipLazyEnqueueDuringRecentFailureCooldown() {
        when(jobStateStore.getJobState(611L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(611L, "trace-611"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(aiServiceClient.getTranscript(611L, "trace-611")).thenReturn(Map.of(
                "meeting_id", 611L,
                "transcripts", List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "failed transcript row")
                )
        ));
        when(jobStateStore.tryStartAnalysis(eq(611L), anyString(), anyString(), anyString()))
                .thenReturn(new JobStateStore.AnalysisTriggerDecision(
                        false,
                        "FAILED",
                        "cooldown_active",
                        null,
                        45,
                        "GEMINI_UNAVAILABLE"
                ));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.getAnalysis(611L, "trace-611", AUTH_HEADER)
        );
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatusCode());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                eq(611L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                eq("trace-611"),
                eq(AUTH_HEADER)
        );
    }

    @Test
    void getAnalysis_shouldNotMarkCompletedWhenRealtimeAnalysisSkippedInProgress() {
        when(jobStateStore.getJobState(612L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(612L, "trace-612"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(aiServiceClient.getTranscript(612L, "trace-612")).thenReturn(Map.of(
                "meeting_id", 612L,
                "transcripts", List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "pending transcript row")
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(612L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                eq("trace-612"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of(
                "status", "skipped",
                "reason", "in_progress",
                "retryAfterSeconds", 30
        ));

        Map<String, Object> response = processingService.getAnalysis(612L, "trace-612", AUTH_HEADER);

        assertEquals("NOT_FOUND", response.get("status"));
        verify(jobStateStore, timeout(1000)).markAnalysisSkipped(
                eq(612L),
                anyString(),
                eq("get_analysis_lazy"),
                eq("processing_service_lazy_poll"),
                eq("lock-token"),
                eq("in_progress"),
                eq(30)
        );
        verify(jobStateStore, never()).markAnalysisCompleted(
                eq(612L),
                anyString(),
                eq("get_analysis_lazy"),
                eq("processing_service_lazy_poll"),
                eq("lock-token")
        );
    }

    @Test
    void getAnalysis_shouldKeepNotReadyWhenRealtimeAnalysisSkippedAlreadyExistsWithoutResult() {
        when(jobStateStore.getJobState(613L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(613L, "trace-613"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(aiServiceClient.getTranscript(613L, "trace-613")).thenReturn(Map.of(
                "meeting_id", 613L,
                "transcripts", List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "no persisted analysis yet")
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(613L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                eq("trace-613"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of(
                "status", "skipped",
                "reason", "already_exists"
        ));

        Map<String, Object> response = processingService.getAnalysis(613L, "trace-613", AUTH_HEADER);

        assertEquals("NOT_FOUND", response.get("status"));
        verify(jobStateStore, timeout(1000)).markAnalysisSkipped(
                eq(613L),
                anyString(),
                eq("get_analysis_lazy"),
                eq("processing_service_lazy_poll"),
                eq("lock-token"),
                eq("already_exists"),
                eq(0)
        );
        verify(jobStateStore, never()).markAnalysisCompleted(
                eq(613L),
                anyString(),
                eq("get_analysis_lazy"),
                eq("processing_service_lazy_poll"),
                eq("lock-token")
        );
    }

    @Test
    void getAnalysis_shouldSkipLazyEnqueueWhenTranscriptNotReady() {
        when(jobStateStore.getJobState(610L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(610L, "trace-610"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(aiServiceClient.getTranscript(610L, "trace-610")).thenReturn(Map.of(
                "meeting_id", 610L,
                "transcripts", List.of()
        ));

        Map<String, Object> response = processingService.getAnalysis(610L, "trace-610", AUTH_HEADER);

        assertEquals("NOT_FOUND", response.get("status"));
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                eq(610L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                eq("trace-610"),
                eq(AUTH_HEADER)
        );
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
