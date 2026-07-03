package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;

import org.apache.poi.xwpf.extractor.XWPFWordExtractor;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.controller.dto.ProcessingStatusResponse;
import com.example.processingservice.service.report.MeetingReportDocxGenerator;

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

    @Mock
    private UploadValidator uploadValidator;

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
                meterRegistry,
                new MeetingReportDocxGenerator());
        processingService.initMetrics();
        lenient().doNothing().when(uploadValidator).validateIfStrict(any(), any());
        ReflectionTestUtils.setField(processingService, "uploadValidator", uploadValidator);

        lenient().when(meetingServiceClient.getMeetingById(anyLong(), anyString(), anyString()))
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
    void getProcessingStatus_shouldSyncCompletedMeetingStatus() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("updatedAt", "2026-04-10T00:00:00Z");

        when(jobStateStore.getJobState(304L)).thenReturn(Optional.of(state));

        ProcessingStatusResponse response = processingService.getProcessingStatus(304L, "trace-304", AUTH_HEADER);

        assertEquals("COMPLETED", response.status());
        verify(meetingServiceClient).updateMeetingStatus(304L, "completed", "trace-304", AUTH_HEADER);
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

        verify(aiServiceClient).getTranscript(777L, "trace-batch");
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
    void getTranscript_v2ShouldFetchExactAttemptScopeAndSkipLegacyStateFallback() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of(
                "transcripts",
                List.of(Map.of("speaker", "SPEAKER_00", "text", "legacy state row"))
        ));
        when(jobStateStore.getJobState(890L)).thenReturn(Optional.of(state));
        when(aiServiceClient.getTranscript(890L, "trace-v2", 9001L, 2L)).thenReturn(Map.of(
                "meeting_id", 890L,
                "transcripts", List.of(
                        Map.of(
                                "speaker", "SPEAKER_01",
                                "text", "attempt row",
                                "recording_session_id", 9001L,
                                "attempt_id", 2L,
                                "stream_id", "tab",
                                "seq", 1
                        )
                )
        ));

        Map<String, Object> response = processingService.getTranscript(890L, "trace-v2", AUTH_HEADER, 9001L, 2L);

        List<?> transcripts = (List<?>) response.get("transcripts");
        assertEquals(1, transcripts.size());
        Map<?, ?> row = (Map<?, ?>) transcripts.get(0);
        assertEquals("attempt row", row.get("text"));
        assertEquals(9001L, row.get("recording_session_id"));
        assertEquals(2L, row.get("attempt_id"));
        verify(aiServiceClient).getTranscript(890L, "trace-v2", 9001L, 2L);
        verify(aiServiceClient, never()).getTranscript(890L, "trace-v2");
    }

    @Test
    void getTranscript_v2EmptyShouldNotFallbackToLegacyStateTranscript() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of(
                "transcripts",
                List.of(Map.of("speaker", "SPEAKER_00", "text", "legacy state row"))
        ));
        when(jobStateStore.getJobState(891L)).thenReturn(Optional.of(state));
        when(aiServiceClient.getTranscript(891L, "trace-v2-empty", 9001L, 3L)).thenReturn(Map.of(
                "meeting_id", 891L,
                "transcripts", List.of()
        ));

        Map<String, Object> response = processingService.getTranscript(891L, "trace-v2-empty", AUTH_HEADER, 9001L, 3L);

        List<?> transcripts = (List<?>) response.get("transcripts");
        assertEquals(0, transcripts.size());
        verify(aiServiceClient).getTranscript(891L, "trace-v2-empty", 9001L, 3L);
        verify(aiServiceClient, never()).getTranscript(891L, "trace-v2-empty");
    }

    @Test
    void getTranscript_shouldRejectPartialProvenanceBeforeAiFetch() {
        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.getTranscript(892L, "trace-partial", AUTH_HEADER, 9001L, null)
        );

        assertEquals(422, ex.getStatusCode().value());
        verify(aiServiceClient, never()).getTranscript(eq(892L), anyString(), anyLong(), anyLong());
        verify(aiServiceClient, never()).getTranscript(eq(892L), anyString());
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
    void getTranscript_v2NotReadyShouldNotFallbackToLegacyStateTranscript() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of(
                "transcripts", List.of(Map.of("speaker", "SPEAKER_1", "text", "legacy row must not leak"))
        ));
        when(jobStateStore.getJobState(894L)).thenReturn(Optional.of(state));
        when(aiServiceClient.getTranscript(894L, "trace-v2-not-ready", 9001L, 2L)).thenReturn(Map.of(
                "meeting_id", 894L,
                "recording_session_id", 9001L,
                "attempt_id", 2L,
                "transcripts", List.of(),
                "status", "NOT_READY",
                "errorCode", "TRANSCRIPT_NOT_READY",
                "transcriptNotReady", true
        ));

        Map<String, Object> response = processingService.getTranscript(
                894L,
                "trace-v2-not-ready",
                AUTH_HEADER,
                9001L,
                2L
        );

        assertEquals("NOT_READY", response.get("status"));
        assertEquals("TRANSCRIPT_NOT_READY", response.get("errorCode"));
        assertEquals(Boolean.TRUE, response.get("transcriptNotReady"));
        assertEquals(9001L, response.get("recording_session_id"));
        assertEquals(2L, response.get("attempt_id"));
        assertTrue(response.get("transcripts") instanceof List<?>);
        assertEquals(0, ((List<?>) response.get("transcripts")).size());
        verify(aiServiceClient).getTranscript(894L, "trace-v2-not-ready", 9001L, 2L);
        verify(aiServiceClient, never()).getTranscript(894L, "trace-v2-not-ready");
    }

    @Test
    void resolveMeetingResultScope_shouldReturnExactV2ScopeFromAiList() {
        when(aiServiceClient.listTranscriptScopes(895L, "trace-scope-resolve")).thenReturn(Map.of(
                "meeting_id", 895L,
                "scopes", List.of(
                        Map.of(
                                "scopeKind", "v2",
                                "recordingSessionId", 9001L,
                                "attemptId", 2L,
                                "finalized", true
                        )
                )
        ));

        Map<String, Object> response = processingService.resolveMeetingResultScope(
                895L,
                "trace-scope-resolve",
                AUTH_HEADER,
                9001L,
                2L
        );

        assertEquals("v2", response.get("scopeKind"));
        assertEquals(9001L, response.get("recordingSessionId"));
        assertEquals(2L, response.get("attemptId"));
        verify(aiServiceClient).listTranscriptScopes(895L, "trace-scope-resolve");
    }

    @Test
    void resolveMeetingResultScope_shouldPreferLatestFinalizedAttemptWhenAmbiguous() {
        when(aiServiceClient.listTranscriptScopes(896L, "trace-scope-ambiguous")).thenReturn(Map.of(
                "scopes", List.of(
                        Map.of(
                                "scopeKind", "v2",
                                "recordingSessionId", 9001L,
                                "attemptId", 1L,
                                "finalized", true
                        ),
                        Map.of(
                                "scopeKind", "v2",
                                "recordingSessionId", 9001L,
                                "attemptId", 3L,
                                "finalized", true
                        )
                )
        ));

        Map<String, Object> response = processingService.resolveMeetingResultScope(
                896L,
                "trace-scope-ambiguous",
                AUTH_HEADER,
                null,
                null
        );

        assertEquals(9001L, response.get("recordingSessionId"));
        assertEquals(3L, response.get("attemptId"));
        assertEquals(Boolean.TRUE, response.get("ambiguous"));
    }

    @Test
    void getAnalysisReadOnly_shouldRequestScopedCacheOnlyAnalysisForV2Attempt() {
        Long meetingId = 960L;
        Map<String, Object> transcriptRow = Map.of(
                "speaker", "SPEAKER_1",
                "text", "Attempt scoped transcript",
                "start_time", 0.0d,
                "end_time", 1.0d
        );
        when(aiServiceClient.getTranscript(eq(meetingId), eq("trace-960"), eq(9001L), eq(2L)))
                .thenReturn(Map.of("meeting_id", meetingId, "transcripts", List.of(transcriptRow)));
        when(aiServiceClient.getSavedAnalysisCacheOnly(
                eq(meetingId),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                eq(9001L),
                eq(2L),
                eq("trace-960"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of(
                "status", "completed",
                "analysisStatus", "COMPLETED",
                "analysis", Map.of("summary", "Attempt two analysis")
        ));

        Map<String, Object> response = processingService.getAnalysisReadOnly(
                meetingId,
                "trace-960",
                AUTH_HEADER,
                9001L,
                2L
        );

        assertEquals("COMPLETED", response.get("analysisStatus"));
        assertEquals("Attempt two analysis", response.get("summary"));
        verify(aiServiceClient, never()).getAnalysis(anyLong(), anyString());
    }

    @Test
    void getAnalysisReadOnly_shouldReturnUnavailableForScopedAttemptWithoutAnalysis() {
        Long meetingId = 961L;
        when(aiServiceClient.getTranscript(eq(meetingId), eq("trace-961"), eq(9001L), eq(3L)))
                .thenReturn(Map.of(
                        "meeting_id", meetingId,
                        "transcripts", List.of(Map.of(
                                "speaker", "SPEAKER_1",
                                "text", "No analysis yet",
                                "start_time", 0.0d,
                                "end_time", 1.0d
                        ))
                ));
        when(aiServiceClient.getSavedAnalysisCacheOnly(
                eq(meetingId),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                eq(9001L),
                eq(3L),
                eq("trace-961"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of(
                "status", "no_analysis",
                "analysisStatus", "ANALYSIS_UNAVAILABLE_FOR_SCOPE"
        ));

        Map<String, Object> response = processingService.getAnalysisReadOnly(
                meetingId,
                "trace-961",
                AUTH_HEADER,
                9001L,
                3L
        );

        assertEquals("ANALYSIS_UNAVAILABLE_FOR_SCOPE", response.get("analysisStatus"));
        assertEquals("NOT_FOUND", response.get("status"));
    }

    @Test
    void getTranscript_shouldPreferCanonicalRowsFromAiFallbackWhenAvailable() {
        when(jobStateStore.getJobState(892L)).thenReturn(Optional.empty());
        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 892L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-892");
        aiPayload.put("canonicalGeneratedAt", "2026-06-01T10:00:00Z");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Canonical cleaned transcript row.",
                        "start_time", 1.0d,
                        "end_time", 2.5d
                )
        ));
        aiPayload.put("rawTranscripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Raw overlapping row one.",
                        "start_time", 1.0d,
                        "end_time", 2.0d
                ),
                Map.of(
                        "speaker", "SPEAKER_2",
                        "text", "Raw overlapping row two.",
                        "start_time", 1.4d,
                        "end_time", 2.6d
                )
        ));
        when(aiServiceClient.getTranscript(892L, "trace-canonical-fallback")).thenReturn(aiPayload);

        Map<String, Object> response = processingService.getTranscript(892L, "trace-canonical-fallback", AUTH_HEADER);

        assertEquals("COMPLETED", response.get("status"));
        assertEquals("canonical", response.get("transcriptMode"));
        List<?> transcripts = (List<?>) response.get("transcripts");
        assertEquals(1, transcripts.size());
        Map<?, ?> row = (Map<?, ?>) transcripts.get(0);
        assertEquals("Canonical cleaned transcript row.", row.get("text"));
        assertTrue(response.get("rawTranscripts") instanceof List<?>);
        assertEquals(2, ((List<?>) response.get("rawTranscripts")).size());
        verify(aiServiceClient).getTranscript(892L, "trace-canonical-fallback");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void getTranscript_shouldPreferAiCanonicalRowsOverStateRowsWhenAvailable() {
        Map<String, Object> stateRow = new HashMap<>();
        stateRow.put("speaker", "SPEAKER_1");
        stateRow.put("text", "state raw transcript row");
        stateRow.put("start_time", 1.0d);
        stateRow.put("end_time", 2.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(stateRow)));
        when(jobStateStore.getJobState(893L)).thenReturn(Optional.of(state));

        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 893L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-893");
        aiPayload.put("canonicalGeneratedAt", "2026-06-01T11:00:00Z");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_9",
                        "text", "canonical readable row",
                        "start_time", 1.0d,
                        "end_time", 2.0d
                )
        ));
        aiPayload.put("rawTranscripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "raw overlap A",
                        "start_time", 1.0d,
                        "end_time", 1.8d
                ),
                Map.of(
                        "speaker", "SPEAKER_2",
                        "text", "raw overlap B",
                        "start_time", 1.1d,
                        "end_time", 2.1d
                )
        ));
        when(aiServiceClient.getTranscript(893L, "trace-state-canonical")).thenReturn(aiPayload);

        Map<String, Object> response = processingService.getTranscript(893L, "trace-state-canonical", AUTH_HEADER);

        assertEquals("COMPLETED", response.get("status"));
        assertEquals("canonical", response.get("transcriptMode"));
        List<?> transcripts = (List<?>) response.get("transcripts");
        assertEquals(1, transcripts.size());
        Map<?, ?> row = (Map<?, ?>) transcripts.get(0);
        assertEquals("canonical readable row", row.get("text"));
        assertEquals(2, ((List<?>) response.get("rawTranscripts")).size());
        verify(aiServiceClient).getTranscript(893L, "trace-state-canonical");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void getTranscript_shouldStabilizeSpeakerIslandAndPreserveProviderSpeakerMetadata() {
        Map<String, Object> firstRow = new HashMap<>();
        firstRow.put("speaker", "SPEAKER_1");
        firstRow.put("text", "We should review");
        firstRow.put("start_time", 0.0d);
        firstRow.put("end_time", 1.0d);

        Map<String, Object> islandRow = new HashMap<>();
        islandRow.put("speaker", "SPEAKER_17");
        islandRow.put("text", "the launch");
        islandRow.put("start_time", 1.1d);
        islandRow.put("end_time", 1.6d);

        Map<String, Object> lastRow = new HashMap<>();
        lastRow.put("speaker", "SPEAKER_1");
        lastRow.put("text", "plan today.");
        lastRow.put("start_time", 1.7d);
        lastRow.put("end_time", 3.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(firstRow, islandRow, lastRow)));
        when(jobStateStore.getJobState(894L)).thenReturn(Optional.of(state));

        Map<String, Object> response = processingService.getTranscript(894L, "trace-speaker-stable", AUTH_HEADER);

        assertEquals("COMPLETED", response.get("status"));
        assertEquals("speaker-stabilization-v1", response.get("speakerStabilizationVersion"));
        List<?> transcripts = (List<?>) response.get("transcripts");
        assertEquals(1, transcripts.size());
        Map<?, ?> row = (Map<?, ?>) transcripts.get(0);
        assertEquals("SPEAKER_1", row.get("speaker"));
        assertEquals("SPEAKER_1/SPEAKER_17", row.get("providerSpeaker"));
        assertEquals("SPEAKER_1/SPEAKER_17", row.get("originalSpeaker"));
        assertEquals("speaker-stabilization-v1", row.get("speakerStabilizationVersion"));
        assertEquals("We should review the launch plan today.", row.get("text"));

        Map<?, ?> stats = (Map<?, ?>) response.get("speakerStats");
        assertEquals(2, ((Number) stats.get("rawSpeakerCount")).intValue());
        assertEquals(1, ((Number) stats.get("stableSpeakerCount")).intValue());
        assertEquals(1, ((Number) stats.get("mergedIslandCount")).intValue());
        assertTrue(((Number) stats.get("mergedTinyFragmentCount")).intValue() >= 1);
        assertEquals("speaker-stabilization-v1", stats.get("stabilizationVersion"));
        assertEquals(17, ((Number) stats.get("largestObservedSpeakerLabelCount")).intValue());
    }

    @Test
    void getTranscript_shouldReturnStabilizedRowsInTimelineOrderForUploadRegression() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(
                transcriptRow("SPEAKER_1", 62.0d, 63.0d, "row at 1:02"),
                transcriptRow("SPEAKER_17", 393.0d, 394.0d, "row at 6:33"),
                transcriptRow("SPEAKER_1", 65.0d, 66.0d, "row at 1:05"),
                transcriptRow("SPEAKER_1", 118.0d, 118.8d, "row at 1:58"),
                transcriptRow("SPEAKER_17", 450.0d, 451.0d, "row at 7:30"),
                transcriptRow("SPEAKER_1", 120.0d, 121.0d, "row at 2:00")
        )));
        when(jobStateStore.getJobState(895L)).thenReturn(Optional.of(state));

        Map<String, Object> response = processingService.getTranscript(895L, "trace-speaker-order", AUTH_HEADER);

        List<?> transcripts = (List<?>) response.get("transcripts");
        assertEquals(6, transcripts.size());
        assertNonDecreasingStartTimes(transcripts);
        assertEquals(List.of(62.0d, 65.0d, 118.0d, 120.0d, 393.0d, 450.0d), transcriptStartTimes(transcripts));
        assertTrue(indexOfText(transcripts, "row at 6:33") > indexOfText(transcripts, "row at 1:05"));
        assertTrue(indexOfText(transcripts, "row at 7:30") > indexOfText(transcripts, "row at 2:00"));

        Map<?, ?> stats = (Map<?, ?>) response.get("speakerStats");
        assertEquals(2, ((Number) stats.get("rawSpeakerCount")).intValue());
        assertEquals(2, ((Number) stats.get("stableSpeakerCount")).intValue());
        assertEquals(0, ((Number) stats.get("mergedIslandCount")).intValue());
        assertEquals(0, ((Number) stats.get("mergedTinyFragmentCount")).intValue());
        assertEquals("speaker-stabilization-v1", stats.get("stabilizationVersion"));
    }

    @Test
    void getTranscript_shouldSortPhase7SRegressionPairsBeforeDisplay() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(
                transcriptRow("SPEAKER_1", 91.0d, 92.0d, "row at 1:31"),
                transcriptRow("SPEAKER_3", 272.0d, 273.0d, "row at 4:32"),
                transcriptRow("SPEAKER_4", 441.0d, 442.0d, "row at 7:21"),
                transcriptRow("SPEAKER_1", 119.0d, 120.0d, "row at 1:59"),
                transcriptRow("SPEAKER_2", 135.0d, 136.0d, "row at 2:15"),
                transcriptRow("SPEAKER_3", 306.0d, 307.0d, "row at 5:06"),
                transcriptRow("SPEAKER_2", 144.0d, 145.0d, "row at 2:24"),
                transcriptRow("SPEAKER_1", 62.0d, 63.0d, "row at 1:02"),
                transcriptRow("SPEAKER_5", 393.0d, 394.0d, "row at 6:33"),
                transcriptRow("SPEAKER_1", 65.0d, 66.0d, "row at 1:05")
        )));
        when(jobStateStore.getJobState(896L)).thenReturn(Optional.of(state));

        Map<String, Object> response = processingService.getTranscript(896L, "trace-speaker-order-pairs", AUTH_HEADER);

        List<?> transcripts = (List<?>) response.get("transcripts");
        assertNonDecreasingStartTimes(transcripts);
        assertEquals(List.of(62.0d, 65.0d, 91.0d, 119.0d, 135.0d, 144.0d, 272.0d, 306.0d, 393.0d, 441.0d), transcriptStartTimes(transcripts));
        assertTrue(indexOfText(transcripts, "row at 1:59") < indexOfText(transcripts, "row at 4:32"));
        assertTrue(indexOfText(transcripts, "row at 1:59") < indexOfText(transcripts, "row at 7:21"));
        assertTrue(indexOfText(transcripts, "row at 2:24") < indexOfText(transcripts, "row at 5:06"));
        assertTrue(indexOfText(transcripts, "row at 1:05") < indexOfText(transcripts, "row at 6:33"));
    }

    @Test
    void generateMeetingTranscriptTxt_shouldUseReadableTranscriptByDefault() {
        Map<String, Object> mainRow = new HashMap<>();
        mainRow.put("speaker", "SPEAKER_1");
        mainRow.put("text", "We should finalize the launch plan.");
        mainRow.put("start_time", 35.829998d);
        mainRow.put("end_time", 37.120001d);

        Map<String, Object> duplicateRow = new HashMap<>();
        duplicateRow.put("speaker", "SPEAKER_2");
        duplicateRow.put("text", "We should finalize the launch plan.");
        duplicateRow.put("start_time", 35.91d);
        duplicateRow.put("end_time", 37.11d);

        Map<String, Object> shortRow = new HashMap<>();
        shortRow.put("speaker", "SPEAKER_2");
        shortRow.put("text", "launch plan");
        shortRow.put("start_time", 36.05d);
        shortRow.put("end_time", 36.81d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(mainRow, duplicateRow, shortRow)));

        when(jobStateStore.getJobState(900L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(900L, "trace-txt", AUTH_HEADER)).thenReturn(Map.of(
                "id", 900L,
                "title", "Weekly planning",
                "language", "en",
                "status", "completed"
        ));

        String content = new String(processingService.generateMeetingTranscriptTxt(900L, "trace-txt", AUTH_HEADER), StandardCharsets.UTF_8);

        assertTrue(content.contains("Meeting: Weekly planning"));
        assertTrue(content.contains("Transcript export mode: readable"));
        assertTrue(content.contains("Recognition Mode: en"));
        assertTrue(content.contains("Detected Transcript Language:"));
        assertTrue(content.contains("Readable transcript export is generated from saved STT output and canonical transcript data when available. Raw export is available with mode=raw."));
        assertTrue(content.contains("[00:36–00:37] SPEAKER_1: We should finalize the launch plan."));
        assertTrue(!content.contains("[00:36–00:37] SPEAKER_2: launch plan"));
        verify(aiServiceClient).getTranscript(900L, "trace-txt");
    }

    @Test
    void generateMeetingTranscriptTxt_shouldCollapseContainedReadableFragmentsLongerThanTinyThreshold() {
        Map<String, Object> longerRow = new HashMap<>();
        longerRow.put("speaker", "SPEAKER_1");
        longerRow.put("text", "The customer requested a faster onboarding flow for new users.");
        longerRow.put("start_time", 20.0d);
        longerRow.put("end_time", 24.0d);

        Map<String, Object> containedRow = new HashMap<>();
        containedRow.put("speaker", "SPEAKER_2");
        containedRow.put("text", "requested a faster onboarding flow for new users");
        containedRow.put("start_time", 20.6d);
        containedRow.put("end_time", 23.2d);

        Map<String, Object> distinctRow = new HashMap<>();
        distinctRow.put("speaker", "SPEAKER_2");
        distinctRow.put("text", "The launch checklist is still pending legal approval.");
        distinctRow.put("start_time", 29.0d);
        distinctRow.put("end_time", 33.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(longerRow, containedRow, distinctRow)));

        when(jobStateStore.getJobState(9002L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(9002L, "trace-txt-readable-collapse", AUTH_HEADER)).thenReturn(Map.of(
                "id", 9002L,
                "title", "Readable collapse check",
                "language", "en",
                "status", "completed"
        ));

        String content = new String(
                processingService.generateMeetingTranscriptTxt(9002L, "trace-txt-readable-collapse", AUTH_HEADER),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("The customer requested a faster onboarding flow for new users."));
        assertTrue(content.contains("The launch checklist is still pending legal approval."));
        assertTrue(!content.contains("[00:21–00:23] SPEAKER_2: requested a faster onboarding flow for new users"));
        verify(aiServiceClient).getTranscript(9002L, "trace-txt-readable-collapse");
    }

    @Test
    void generateMeetingTranscriptTxt_shouldPreserveRawTranscriptWhenRequested() {
        Map<String, Object> firstRow = new HashMap<>();
        firstRow.put("speaker", "SPEAKER_1");
        firstRow.put("text", "raw txt row 1");
        firstRow.put("start_time", 1.5d);
        firstRow.put("end_time", 4.0d);

        Map<String, Object> secondRow = new HashMap<>();
        secondRow.put("speaker", "SPEAKER_2");
        secondRow.put("text", "raw txt row 2");
        secondRow.put("start_time", 4.5d);
        secondRow.put("end_time", 6.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(firstRow, secondRow)));

        when(jobStateStore.getJobState(9001L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(9001L, "trace-txt-raw", AUTH_HEADER)).thenReturn(Map.of(
                "id", 9001L,
                "title", "Weekly planning",
                "language", "en",
                "status", "completed"
        ));

        String content = new String(processingService.generateMeetingTranscriptTxt(9001L, "trace-txt-raw", AUTH_HEADER, "raw"), StandardCharsets.UTF_8);

        assertTrue(content.contains("Transcript export mode: raw"));
        assertTrue(content.contains("Raw transcript export from saved STT output. May contain overlapping STT fragments."));
        assertTrue(content.contains("[00:02–00:04] SPEAKER_1: raw txt row 1"));
        assertTrue(content.contains("[00:05–00:06] SPEAKER_2: raw txt row 2"));
        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
    }

    @Test
    void generateMeetingTranscriptTxt_shouldUseStableSpeakerForShortIsland() {
        Map<String, Object> firstRow = new HashMap<>();
        firstRow.put("speaker", "SPEAKER_1");
        firstRow.put("text", "We should review");
        firstRow.put("start_time", 0.0d);
        firstRow.put("end_time", 1.0d);

        Map<String, Object> islandRow = new HashMap<>();
        islandRow.put("speaker", "SPEAKER_17");
        islandRow.put("text", "the launch");
        islandRow.put("start_time", 1.1d);
        islandRow.put("end_time", 1.6d);

        Map<String, Object> lastRow = new HashMap<>();
        lastRow.put("speaker", "SPEAKER_1");
        lastRow.put("text", "plan today.");
        lastRow.put("start_time", 1.7d);
        lastRow.put("end_time", 3.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(firstRow, islandRow, lastRow)));

        when(jobStateStore.getJobState(9003L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(9003L, "trace-speaker-readable", AUTH_HEADER)).thenReturn(Map.of(
                "id", 9003L,
                "title", "Speaker readable",
                "language", "en",
                "status", "completed"
        ));

        String content = new String(
                processingService.generateMeetingTranscriptTxt(9003L, "trace-speaker-readable", AUTH_HEADER),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("[00:00–00:03] SPEAKER_1: We should review the launch plan today."));
        assertTrue(!content.contains("SPEAKER_17"));
        verify(aiServiceClient).getTranscript(9003L, "trace-speaker-readable");
    }

    @Test
    void generateMeetingTranscriptTxt_shouldKeepRawSpeakerJumpWhenRawModeRequested() {
        Map<String, Object> firstRow = new HashMap<>();
        firstRow.put("speaker", "SPEAKER_1");
        firstRow.put("text", "We should review");
        firstRow.put("start_time", 0.0d);
        firstRow.put("end_time", 1.0d);

        Map<String, Object> islandRow = new HashMap<>();
        islandRow.put("speaker", "SPEAKER_17");
        islandRow.put("text", "the launch");
        islandRow.put("start_time", 1.1d);
        islandRow.put("end_time", 1.6d);

        Map<String, Object> lastRow = new HashMap<>();
        lastRow.put("speaker", "SPEAKER_1");
        lastRow.put("text", "plan today.");
        lastRow.put("start_time", 1.7d);
        lastRow.put("end_time", 3.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(firstRow, islandRow, lastRow)));

        when(jobStateStore.getJobState(9004L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(9004L, "trace-speaker-raw", AUTH_HEADER)).thenReturn(Map.of(
                "id", 9004L,
                "title", "Speaker raw",
                "language", "en",
                "status", "completed"
        ));

        String content = new String(
                processingService.generateMeetingTranscriptTxt(9004L, "trace-speaker-raw", AUTH_HEADER, "raw"),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("Transcript export mode: raw"));
        assertTrue(content.contains("[00:01–00:02] SPEAKER_17: the launch"));
        assertTrue(!content.contains("We should review the launch plan today."));
        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
    }

    @Test
    void generateMeetingTranscriptTxt_shouldSortReadableRowsButKeepRawProviderOrder() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(
                transcriptRow("SPEAKER_1", 62.0d, 63.0d, "row at 1:02"),
                transcriptRow("SPEAKER_17", 393.0d, 394.0d, "row at 6:33"),
                transcriptRow("SPEAKER_1", 65.0d, 66.0d, "row at 1:05"),
                transcriptRow("SPEAKER_1", 118.0d, 118.8d, "row at 1:58"),
                transcriptRow("SPEAKER_17", 450.0d, 451.0d, "row at 7:30"),
                transcriptRow("SPEAKER_1", 120.0d, 121.0d, "row at 2:00")
        )));

        when(jobStateStore.getJobState(9007L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(9007L, "trace-speaker-order-export", AUTH_HEADER)).thenReturn(Map.of(
                "id", 9007L,
                "title", "Speaker order export",
                "language", "en",
                "status", "completed"
        ));

        String readableContent = new String(
                processingService.generateMeetingTranscriptTxt(9007L, "trace-speaker-order-export", AUTH_HEADER),
                StandardCharsets.UTF_8
        );
        assertTrue(readableContent.indexOf("row at 1:05") < readableContent.indexOf("row at 6:33"));
        assertTrue(readableContent.indexOf("row at 2:00") < readableContent.indexOf("row at 7:30"));

        String rawContent = new String(
                processingService.generateMeetingTranscriptTxt(9007L, "trace-speaker-order-export", AUTH_HEADER, "raw"),
                StandardCharsets.UTF_8
        );
        assertTrue(rawContent.indexOf("row at 6:33") < rawContent.indexOf("row at 1:05"));
        assertTrue(rawContent.indexOf("row at 7:30") < rawContent.indexOf("row at 2:00"));
        assertTrue(rawContent.contains("[06:33–06:34] SPEAKER_17: row at 6:33"));
        assertTrue(rawContent.contains("[07:30–07:31] SPEAKER_17: row at 7:30"));
    }

    @Test
    void generateMeetingTranscriptTxt_shouldNotMergeSpeakerIslandAcrossLargeGap() {
        Map<String, Object> firstRow = new HashMap<>();
        firstRow.put("speaker", "SPEAKER_1");
        firstRow.put("text", "We opened the meeting");
        firstRow.put("start_time", 0.0d);
        firstRow.put("end_time", 1.0d);

        Map<String, Object> separateRow = new HashMap<>();
        separateRow.put("speaker", "SPEAKER_17");
        separateRow.put("text", "This is a separate update");
        separateRow.put("start_time", 3.2d);
        separateRow.put("end_time", 4.0d);

        Map<String, Object> lastRow = new HashMap<>();
        lastRow.put("speaker", "SPEAKER_1");
        lastRow.put("text", "Then we moved on.");
        lastRow.put("start_time", 4.2d);
        lastRow.put("end_time", 5.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(firstRow, separateRow, lastRow)));

        when(jobStateStore.getJobState(9005L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(9005L, "trace-speaker-gap", AUTH_HEADER)).thenReturn(Map.of(
                "id", 9005L,
                "title", "Speaker gap",
                "language", "en",
                "status", "completed"
        ));

        String content = new String(
                processingService.generateMeetingTranscriptTxt(9005L, "trace-speaker-gap", AUTH_HEADER),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("SPEAKER_1: We opened the meeting"));
        assertTrue(content.contains("SPEAKER_2: This is a separate update"));
        assertTrue(content.contains("SPEAKER_1: Then we moved on."));
    }

    @Test
    void generateMeetingTranscriptTxt_shouldNotMergeIndependentSpeakerTurn() {
        Map<String, Object> firstRow = new HashMap<>();
        firstRow.put("speaker", "SPEAKER_1");
        firstRow.put("text", "We opened the topic");
        firstRow.put("start_time", 0.0d);
        firstRow.put("end_time", 1.0d);

        Map<String, Object> independentRow = new HashMap<>();
        independentRow.put("speaker", "SPEAKER_17");
        independentRow.put("text", "I disagree.");
        independentRow.put("start_time", 1.1d);
        independentRow.put("end_time", 1.8d);

        Map<String, Object> lastRow = new HashMap<>();
        lastRow.put("speaker", "SPEAKER_1");
        lastRow.put("text", "Let's capture both views.");
        lastRow.put("start_time", 1.9d);
        lastRow.put("end_time", 3.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(firstRow, independentRow, lastRow)));

        when(jobStateStore.getJobState(9006L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(9006L, "trace-speaker-turn", AUTH_HEADER)).thenReturn(Map.of(
                "id", 9006L,
                "title", "Speaker turn",
                "language", "en",
                "status", "completed"
        ));

        String content = new String(
                processingService.generateMeetingTranscriptTxt(9006L, "trace-speaker-turn", AUTH_HEADER),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("SPEAKER_2: I disagree."));
        assertTrue(!content.contains("We opened the topic I disagree. Let's capture both views."));
    }

    @Test
    void generateMeetingTranscriptCsv_shouldUseReadableTranscriptByDefault() {
        Map<String, Object> firstRow = new HashMap<>();
        firstRow.put("speaker", "SPEAKER_1");
        firstRow.put("text", "raw csv row 1");
        firstRow.put("start_time", 1.0d);
        firstRow.put("end_time", 3.0d);

        Map<String, Object> duplicateRow = new HashMap<>();
        duplicateRow.put("speaker", "SPEAKER_2");
        duplicateRow.put("text", "raw csv row 1");
        duplicateRow.put("start_time", 1.1d);
        duplicateRow.put("end_time", 3.1d);

        Map<String, Object> shortRow = new HashMap<>();
        shortRow.put("speaker", "SPEAKER_3");
        shortRow.put("text", "raw csv row");
        shortRow.put("start_time", 3.5d);
        shortRow.put("end_time", 4.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(firstRow, duplicateRow, shortRow)));

        when(jobStateStore.getJobState(901L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(901L, "trace-csv", AUTH_HEADER)).thenReturn(Map.of(
                "id", 901L,
                "title", "Weekly planning",
                "language", "vi",
                "status", "completed"
        ));

        String content = new String(processingService.generateMeetingTranscriptCsv(901L, "trace-csv", AUTH_HEADER), StandardCharsets.UTF_8);

        assertTrue(content.startsWith("index,startTime,endTime,speaker,text"));
        assertTrue(content.contains("1,\"00:01\",\"00:03\",\"SPEAKER_1\",\"raw csv row 1\""));
        assertEquals(2, content.lines().count());
        assertTrue(!content.contains("SPEAKER_3"));
        verify(aiServiceClient).getTranscript(901L, "trace-csv");
    }

    @Test
    void generateMeetingTranscriptCsv_shouldPreserveRawTranscriptWhenRequested() {
        Map<String, Object> firstRow = new HashMap<>();
        firstRow.put("speaker", "SPEAKER_1");
        firstRow.put("text", "raw csv row 1");
        firstRow.put("start_time", 1.0d);
        firstRow.put("end_time", 3.0d);

        Map<String, Object> secondRow = new HashMap<>();
        secondRow.put("speaker", "SPEAKER_2");
        secondRow.put("text", "raw csv, row 2 \"quoted\"");
        secondRow.put("start_time", 3.5d);
        secondRow.put("end_time", 7.25d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(firstRow, secondRow)));

        when(jobStateStore.getJobState(9011L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(9011L, "trace-csv-raw", AUTH_HEADER)).thenReturn(Map.of(
                "id", 9011L,
                "title", "Weekly planning",
                "language", "vi",
                "status", "completed"
        ));

        String content = new String(processingService.generateMeetingTranscriptCsv(9011L, "trace-csv-raw", AUTH_HEADER, "raw"), StandardCharsets.UTF_8);

        assertTrue(content.startsWith("index,startTime,endTime,speaker,text"));
        assertTrue(content.contains("1,\"00:01\",\"00:03\",\"SPEAKER_1\",\"raw csv row 1\""));
        assertTrue(content.contains("2,\"00:04\",\"00:07\",\"SPEAKER_2\",\"raw csv, row 2 \""));
        assertTrue(content.contains("\"\"quoted\"\""));
        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
    }

    @Test
    void generateMeetingTranscriptTxt_shouldUseAiPersistedTranscriptWhenJobStateMissing() {
        when(jobStateStore.getJobState(903L)).thenReturn(Optional.empty());
        when(meetingServiceClient.getMeetingById(903L, "trace-ai-readable", AUTH_HEADER)).thenReturn(Map.of(
                "id", 903L,
                "title", "AI persisted transcript",
                "language", "en",
                "status", "completed"
        ));
        when(aiServiceClient.getTranscript(903L, "trace-ai-readable")).thenReturn(Map.of(
                "meeting_id", 903L,
                "transcripts", List.of(
                        Map.of(
                                "speaker", "SPEAKER_1",
                                "text", "We should publish the onboarding update this week.",
                                "start_time", 12.0d,
                                "end_time", 15.0d
                        ),
                        Map.of(
                                "speaker", "SPEAKER_2",
                                "text", "onboarding update",
                                "start_time", 12.4d,
                                "end_time", 13.2d
                        )
                )
        ));

        String content = new String(
                processingService.generateMeetingTranscriptTxt(903L, "trace-ai-readable", AUTH_HEADER, "readable"),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("We should publish the onboarding update this week."));
        assertTrue(!content.contains("[00:12–00:13] SPEAKER_2: onboarding update"));
        verify(aiServiceClient).getTranscript(903L, "trace-ai-readable");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingTranscriptCsv_shouldUseAiPersistedTranscriptWhenJobStateMissingAndRawRequested() {
        when(jobStateStore.getJobState(904L)).thenReturn(Optional.empty());
        when(meetingServiceClient.getMeetingById(904L, "trace-ai-raw-csv", AUTH_HEADER)).thenReturn(Map.of(
                "id", 904L,
                "title", "AI persisted transcript raw",
                "language", "en",
                "status", "completed"
        ));
        when(aiServiceClient.getTranscript(904L, "trace-ai-raw-csv")).thenReturn(Map.of(
                "meeting_id", 904L,
                "transcripts", List.of(
                        Map.of(
                                "speaker", "SPEAKER_1",
                                "text", "raw row from ai source",
                                "start_time", 2.0d,
                                "end_time", 3.0d
                        ),
                        Map.of(
                                "speaker", "SPEAKER_2",
                                "text", "second raw row from ai source",
                                "start_time", 3.2d,
                                "end_time", 4.1d
                        )
                )
        ));

        String content = new String(
                processingService.generateMeetingTranscriptCsv(904L, "trace-ai-raw-csv", AUTH_HEADER, "raw"),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("1,\"00:02\",\"00:03\",\"SPEAKER_1\",\"raw row from ai source\""));
        assertTrue(content.contains("2,\"00:03\",\"00:04\",\"SPEAKER_2\",\"second raw row from ai source\""));
        verify(aiServiceClient).getTranscript(904L, "trace-ai-raw-csv");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingTranscriptTxt_shouldUseCanonicalRowsFromAiPersistedTranscriptWhenAvailable() {
        when(jobStateStore.getJobState(906L)).thenReturn(Optional.empty());
        when(meetingServiceClient.getMeetingById(906L, "trace-ai-canonical-readable", AUTH_HEADER)).thenReturn(Map.of(
                "id", 906L,
                "title", "AI canonical readable transcript",
                "language", "en",
                "status", "completed"
        ));
        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 906L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-906");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Vocabulary is a nightmare.",
                        "start_time", 4.0d,
                        "end_time", 6.0d
                )
        ));
        aiPayload.put("rawTranscripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Vocabulary",
                        "start_time", 4.0d,
                        "end_time", 5.0d
                ),
                Map.of(
                        "speaker", "SPEAKER_2",
                        "text", "is a nightmare.",
                        "start_time", 5.2d,
                        "end_time", 6.0d
                )
        ));
        when(aiServiceClient.getTranscript(906L, "trace-ai-canonical-readable")).thenReturn(aiPayload);

        String content = new String(
                processingService.generateMeetingTranscriptTxt(906L, "trace-ai-canonical-readable", AUTH_HEADER),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("Transcript export mode: readable"));
        assertTrue(content.contains("SPEAKER_1: Vocabulary is a nightmare."));
        assertTrue(!content.contains("SPEAKER_1: Vocabulary\n"));
        assertTrue(!content.contains("SPEAKER_2: is a nightmare."));
        verify(aiServiceClient).getTranscript(906L, "trace-ai-canonical-readable");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingTranscriptTxt_rawMode_shouldUseRawRowsWhenAiTranscriptIsCanonical() {
        when(jobStateStore.getJobState(907L)).thenReturn(Optional.empty());
        when(meetingServiceClient.getMeetingById(907L, "trace-ai-canonical-raw", AUTH_HEADER)).thenReturn(Map.of(
                "id", 907L,
                "title", "AI canonical raw transcript",
                "language", "en",
                "status", "completed"
        ));
        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 907L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-907");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Vocabulary is a nightmare.",
                        "start_time", 7.0d,
                        "end_time", 9.0d
                )
        ));
        aiPayload.put("rawTranscripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Vocabulary",
                        "start_time", 7.0d,
                        "end_time", 8.0d
                ),
                Map.of(
                        "speaker", "SPEAKER_2",
                        "text", "is a nightmare.",
                        "start_time", 8.2d,
                        "end_time", 9.0d
                )
        ));
        when(aiServiceClient.getTranscript(907L, "trace-ai-canonical-raw")).thenReturn(aiPayload);

        String content = new String(
                processingService.generateMeetingTranscriptTxt(907L, "trace-ai-canonical-raw", AUTH_HEADER, "raw"),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("Transcript export mode: raw"));
        assertTrue(content.contains("SPEAKER_1: Vocabulary"));
        assertTrue(content.contains("SPEAKER_2: is a nightmare."));
        assertTrue(!content.contains("SPEAKER_1: Vocabulary is a nightmare."));
        verify(aiServiceClient).getTranscript(907L, "trace-ai-canonical-raw");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingTranscriptTxt_readable_shouldPreferCanonicalRowsOverJobStateRowsWhenAvailable() {
        Map<String, Object> stateRow = new HashMap<>();
        stateRow.put("speaker", "SPEAKER_1");
        stateRow.put("text", "state raw row should be hidden by canonical");
        stateRow.put("start_time", 2.0d);
        stateRow.put("end_time", 3.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(stateRow)));
        when(jobStateStore.getJobState(908L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(908L, "trace-state-canonical-readable", AUTH_HEADER)).thenReturn(Map.of(
                "id", 908L,
                "title", "State plus canonical",
                "language", "en",
                "status", "completed"
        ));

        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 908L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-908");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_9",
                        "text", "canonical readable row for export",
                        "start_time", 2.0d,
                        "end_time", 3.0d
                )
        ));
        aiPayload.put("rawTranscripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "raw overlap one",
                        "start_time", 2.0d,
                        "end_time", 2.6d
                ),
                Map.of(
                        "speaker", "SPEAKER_2",
                        "text", "raw overlap two",
                        "start_time", 2.1d,
                        "end_time", 3.1d
                )
        ));
        when(aiServiceClient.getTranscript(908L, "trace-state-canonical-readable")).thenReturn(aiPayload);

        String content = new String(
                processingService.generateMeetingTranscriptTxt(908L, "trace-state-canonical-readable", AUTH_HEADER),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("Transcript export mode: readable"));
        assertTrue(content.contains("canonical readable row for export"));
        assertTrue(!content.contains("state raw row should be hidden by canonical"));
        assertTrue(!content.contains("raw overlap one"));
        assertTrue(!content.contains("raw overlap two"));
        verify(aiServiceClient).getTranscript(908L, "trace-state-canonical-readable");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingTranscriptCsv_readable_shouldPreferCanonicalRowsOverJobStateRowsWhenAvailable() {
        Map<String, Object> stateRow = new HashMap<>();
        stateRow.put("speaker", "SPEAKER_1");
        stateRow.put("text", "state csv row should not be used");
        stateRow.put("start_time", 10.0d);
        stateRow.put("end_time", 11.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(stateRow)));
        when(jobStateStore.getJobState(909L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(909L, "trace-state-canonical-csv", AUTH_HEADER)).thenReturn(Map.of(
                "id", 909L,
                "title", "State plus canonical csv",
                "language", "en",
                "status", "completed"
        ));

        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 909L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-909");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_9",
                        "text", "canonical csv row",
                        "start_time", 10.0d,
                        "end_time", 12.0d
                )
        ));
        when(aiServiceClient.getTranscript(909L, "trace-state-canonical-csv")).thenReturn(aiPayload);

        String content = new String(
                processingService.generateMeetingTranscriptCsv(909L, "trace-state-canonical-csv", AUTH_HEADER),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("1,\"00:10\",\"00:12\",\"SPEAKER_1\",\"canonical csv row\""));
        assertTrue(!content.contains("state csv row should not be used"));
        verify(aiServiceClient).getTranscript(909L, "trace-state-canonical-csv");
    }

    @Test
    void generateMeetingTranscriptTxt_rawMode_shouldKeepStateRawRowsWhenAvailable() {
        Map<String, Object> stateRow = new HashMap<>();
        stateRow.put("speaker", "SPEAKER_1");
        stateRow.put("text", "state raw row remains for raw mode");
        stateRow.put("start_time", 4.0d);
        stateRow.put("end_time", 5.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(stateRow)));
        when(jobStateStore.getJobState(910L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(910L, "trace-raw-state-priority", AUTH_HEADER)).thenReturn(Map.of(
                "id", 910L,
                "title", "Raw state priority",
                "language", "en",
                "status", "completed"
        ));

        String content = new String(
                processingService.generateMeetingTranscriptTxt(910L, "trace-raw-state-priority", AUTH_HEADER, "raw"),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("Transcript export mode: raw"));
        assertTrue(content.contains("state raw row remains for raw mode"));
        verify(aiServiceClient, never()).getTranscript(910L, "trace-raw-state-priority");
    }

    @Test
    void generateMeetingTranscriptTxt_shouldPreferProcessingJobStateOverAiPersistedTranscript() {
        Map<String, Object> stateRow = new HashMap<>();
        stateRow.put("speaker", "SPEAKER_1");
        stateRow.put("text", "row from processing job state");
        stateRow.put("start_time", 1.0d);
        stateRow.put("end_time", 2.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(stateRow)));

        when(jobStateStore.getJobState(905L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(905L, "trace-state-first", AUTH_HEADER)).thenReturn(Map.of(
                "id", 905L,
                "title", "State preferred",
                "language", "en",
                "status", "completed"
        ));

        String content = new String(
                processingService.generateMeetingTranscriptTxt(905L, "trace-state-first", AUTH_HEADER, "raw"),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("row from processing job state"));
        verify(aiServiceClient, never()).getTranscript(905L, "trace-state-first");
    }

    @Test
    void generateMeetingTranscriptTxt_shouldReturnNotFoundWhenSavedTranscriptMissing() {
        when(jobStateStore.getJobState(902L)).thenReturn(Optional.empty());
        when(meetingServiceClient.getMeetingById(902L, "trace-missing", AUTH_HEADER)).thenReturn(Map.of(
                "id", 902L,
                "title", "Weekly planning",
                "language", "en",
                "status", "completed"
        ));
        when(aiServiceClient.getTranscript(902L, "trace-missing")).thenReturn(Map.of(
                "meeting_id", 902L,
                "transcripts", List.of()
        ));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.generateMeetingTranscriptTxt(902L, "trace-missing", AUTH_HEADER)
        );

        assertEquals(HttpStatus.NOT_FOUND, ex.getStatusCode());
        assertEquals("Transcript is not ready yet.", ex.getReason());
        verify(aiServiceClient).getTranscript(902L, "trace-missing");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void getAnalysis_shouldFlattenAnalysisMapAndNormalizeStatus() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "pending");
        state.put("result", Map.of("analysis", Map.of("summary", "ok", "sentiment", "positive")));

        when(jobStateStore.getJobState(505L)).thenReturn(Optional.of(state));

        Map<String, Object> response = processingService.getAnalysis(505L, "trace-5", AUTH_HEADER);

        assertEquals("PENDING", response.get("status"));
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

        assertEquals("SUCCEEDED", response.get("status"));
        assertEquals("Realtime summary", response.get("summary"));
        assertEquals("it", response.get("domainMode"));
        verify(aiServiceClient).getAnalysis(606L, "trace-606");
    }

        @Test
        void getAnalysisReadOnly_shouldReturnStoredAnalysisWithoutLazyTrigger() {
                when(jobStateStore.getJobState(700L)).thenReturn(Optional.empty());
                when(aiServiceClient.getAnalysis(700L, "trace-700")).thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

        Map<String, Object> response = processingService.getAnalysisReadOnly(700L, "trace-700", AUTH_HEADER);

        assertEquals("NOT_STARTED", response.get("status"));
                verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                                eq(700L),
                                anyString(),
                                eq("it"),
                                eq("realtime"),
                                anyString(),
                                anyString(),
                                anyString(),
                                eq("trace-700"),
                                eq(AUTH_HEADER)
                );
        }

        @Test
        void getAnalysisReadOnly_shouldMapQueuedStateToPendingWithoutLazyTrigger() {
                when(jobStateStore.getJobState(701L)).thenReturn(Optional.of(Map.of("status", "QUEUED")));
                when(aiServiceClient.getAnalysis(701L, "trace-701")).thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

                Map<String, Object> response = processingService.getAnalysisReadOnly(701L, "trace-701", AUTH_HEADER);

                assertEquals("PENDING", response.get("status"));
                verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                                eq(701L),
                                anyString(),
                                eq("it"),
                                eq("realtime"),
                                anyString(),
                                anyString(),
                                anyString(),
                                eq("trace-701"),
                                eq(AUTH_HEADER)
                );
        }

        @Test
        void getAnalysisReadOnly_shouldMapNotReadyAndNotFoundForPollingContract() {
                when(jobStateStore.getJobState(702L)).thenReturn(Optional.of(Map.of("status", "NOT_READY")));
                when(aiServiceClient.getAnalysis(702L, "trace-702")).thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

                Map<String, Object> notReady = processingService.getAnalysisReadOnly(702L, "trace-702", AUTH_HEADER);

                assertEquals("PENDING", notReady.get("status"));

                when(jobStateStore.getJobState(703L)).thenReturn(Optional.empty());
                when(aiServiceClient.getAnalysis(703L, "trace-703")).thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

                Map<String, Object> notFound = processingService.getAnalysisReadOnly(703L, "trace-703", AUTH_HEADER);

                assertEquals("NOT_STARTED", notFound.get("status"));
        }

    @Test
    void generateMeetingReportDocx_shouldIncludeAppendixAndAnalyzedHighlights() throws Exception {
        Map<String, Object> transcriptEarly = new HashMap<>();
        transcriptEarly.put("speaker", "SPEAKER_00");
        transcriptEarly.put("text", "Let's review blockers and dependencies.");
        transcriptEarly.put("start_time", 12.2d);
        transcriptEarly.put("end_time", 14.0d);

        Map<String, Object> transcriptMain = new HashMap<>();
        transcriptMain.put("speaker", "SPEAKER_00");
        transcriptMain.put("text", "We should finalize the launch plan.");
        transcriptMain.put("start_time", 35.829998d);
        transcriptMain.put("end_time", 37.120001d);

        Map<String, Object> transcriptDuplicate = new HashMap<>();
        transcriptDuplicate.put("speaker", "SPEAKER_00");
        transcriptDuplicate.put("text", "We should finalize the launch plan.");
        transcriptDuplicate.put("start_time", 35.91d);
        transcriptDuplicate.put("end_time", 37.11d);

        Map<String, Object> transcriptNearDuplicate = new HashMap<>();
        transcriptNearDuplicate.put("speaker", "SPEAKER_00");
        transcriptNearDuplicate.put("text", "launch plan");
        transcriptNearDuplicate.put("start_time", 36.05d);
        transcriptNearDuplicate.put("end_time", 36.81d);

        Map<String, Object> analysis = new HashMap<>();
        analysis.put("summary", "Discussion about release planning");
        analysis.put("keyDecisions", List.of("Ship on Friday"));
        analysis.put("risks", List.of("Vendor delay"));
        analysis.put("nextSteps", List.of("Share launch notes"));
        analysis.put("businessActionItems", List.of(
                Map.of("task", "Prepare rollout checklist", "owner", "Alice", "dueDate", "2026-06-01", "evidence", "Confirmed by team")
        ));
        analysis.put("promptVersion", "gemini-business-v1");
        analysis.put("schemaVersion", "gemini-business-v1");
        analysis.put("analysisStatus", "COMPLETED");
        analysis.put("cacheHit", true);
        analysis.put("provider", "gemini");
        analysis.put("model", "gemini-2.5-flash");
        analysis.put("canonicalTranscriptHash", "canonical-hash-920");
        analysis.put("canonicalTranscriptVersion", "canonical-transcript-v1");

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(
                transcriptMain,
                transcriptDuplicate,
                transcriptEarly,
                transcriptNearDuplicate
        ), "analysis", analysis));
        when(jobStateStore.getJobState(920L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(920L, "trace-920", AUTH_HEADER)).thenReturn(Map.of(
                "id", 920L,
                "title", "Weekly planning",
                "createdAt", "2026-05-30T10:00:00Z",
                "language", "multi",
                "status", "completed",
                "originalFileName", "planning.wav",
                "ownerUserId", 77L,
                "fileSize", 12345L
        ));

        byte[] report = processingService.generateMeetingReportDocx(920L, "trace-920", AUTH_HEADER);

        assertTrue(report.length > 0);
        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            var tables = doc.getTables();
            var appendixTable = tables.get(tables.size() - 1);
            var appendixRows = appendixTable.getRows().stream()
                    .skip(1)
                    .map((row) -> row.getCell(3).getText().trim())
                    .collect(Collectors.toList());
            var appendixTimes = appendixTable.getRows().stream()
                    .skip(1)
                    .map((row) -> row.getCell(1).getText().trim())
                    .collect(Collectors.toList());

            assertTrue(content.contains("Recognition Mode"));
            assertTrue(content.contains("multi"));
            assertTrue(content.contains("Detected Transcript Language"));
            assertTrue(content.contains("English"));
            assertTrue(content.contains("Analyzed Highlights Table"));
            assertTrue(content.contains("Appendix A — Transcript Evidence Preview"));
            assertTrue(content.contains("This section shows a short readable preview generated from saved STT output and canonical transcript data when available."));
            assertTrue(content.contains("completed"));
            assertTrue(content.contains("gemini"));
            assertTrue(content.contains("Preview limited because the saved transcript contains overlapping STT fragments."));
            assertTrue(content.contains("Let's review blockers and dependencies."));
            assertTrue(content.contains("We should finalize the launch plan."));
            assertTrue(content.contains("Ship on Friday"));
            assertTrue(content.contains("Prepare rollout checklist"));
            assertTrue(content.contains("Vendor delay"));
            assertTrue(content.contains("Share launch notes"));
            assertTrue(content.contains("Action Item"));
            assertTrue(!content.contains("35.829998"));
            assertTrue(appendixRows.size() <= 30);
            assertEquals(2, appendixRows.size());
            assertTrue(appendixRows.contains("Let's review blockers and dependencies."));
            assertTrue(appendixRows.contains("We should finalize the launch plan."));
            assertTrue(!appendixRows.contains("launch plan"));
            assertTrue(appendixTimes.contains("00:12–00:14"));
            assertTrue(appendixTimes.contains("00:36–00:37"));
            assertEquals(List.of("00:12–00:14", "00:36–00:37"), appendixTimes);
            assertEquals(content.indexOf("We should finalize the launch plan."), content.lastIndexOf("We should finalize the launch plan."));
            assertTrue(!content.contains("Cleaned/Analyzed Transcript Table"));
            assertTrue(!content.contains("Mapped conservatively from saved transcript"));
            assertTrue(!content.contains("Appendix A — Raw Transcript"));
        }
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                eq(920L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-920"),
                eq(AUTH_HEADER)
        );
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
    }

    @Test
    void generateMeetingReportDocx_shouldAllowTranscriptOnlyWhenAnalysisMissing() throws Exception {
        Map<String, Object> transcriptRow = new HashMap<>();
        transcriptRow.put("speaker", "SPEAKER_01");
        transcriptRow.put("text", "Transcript-only export is allowed.");
        transcriptRow.put("start_time", 3.0d);
        transcriptRow.put("end_time", 5.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(transcriptRow)));
        when(jobStateStore.getJobState(921L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(921L, "trace-921", AUTH_HEADER)).thenReturn(Map.of(
                "id", 921L,
                "title", "Transcript only",
                "createdAt", "2026-05-30T10:30:00Z",
                "language", "vi",
                "status", "completed"
        ));

        byte[] report = processingService.generateMeetingReportDocx(921L, "trace-921", AUTH_HEADER);

        assertTrue(report.length > 0);
        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("Transcript-only export is allowed."));
            assertTrue(content.contains("Analysis not available"));
            assertTrue(content.contains("No analyzed highlights available."));
            assertTrue(content.contains("Appendix A — Transcript Evidence Preview"));
            assertTrue(content.contains("This section shows a short readable preview generated from saved STT output and canonical transcript data when available."));
        }
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                eq(921L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-921"),
                eq(AUTH_HEADER)
        );
    }

    @Test
    void generateMeetingReportDocx_shouldUseStableSpeakerForTranscriptPreview() throws Exception {
        Map<String, Object> firstRow = new HashMap<>();
        firstRow.put("speaker", "SPEAKER_1");
        firstRow.put("text", "We should review");
        firstRow.put("start_time", 0.0d);
        firstRow.put("end_time", 1.0d);

        Map<String, Object> islandRow = new HashMap<>();
        islandRow.put("speaker", "SPEAKER_17");
        islandRow.put("text", "the launch");
        islandRow.put("start_time", 1.1d);
        islandRow.put("end_time", 1.6d);

        Map<String, Object> lastRow = new HashMap<>();
        lastRow.put("speaker", "SPEAKER_1");
        lastRow.put("text", "plan today.");
        lastRow.put("start_time", 1.7d);
        lastRow.put("end_time", 3.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(firstRow, islandRow, lastRow)));
        when(jobStateStore.getJobState(9261L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(9261L, "trace-9261", AUTH_HEADER)).thenReturn(Map.of(
                "id", 9261L,
                "title", "Speaker docx preview",
                "createdAt", "2026-06-01T12:30:00Z",
                "language", "en",
                "status", "completed"
        ));

        byte[] report = processingService.generateMeetingReportDocx(9261L, "trace-9261", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("SPEAKER_1"));
            assertTrue(content.contains("We should review the launch plan today."));
            assertTrue(!content.contains("SPEAKER_17"));
        }
        verify(aiServiceClient).getTranscript(9261L, "trace-9261");
    }

    @Test
    void generateMeetingReportDocx_shouldUseAiPersistedTranscriptWhenJobStateMissing() throws Exception {
        when(jobStateStore.getJobState(926L)).thenReturn(Optional.empty());
        when(meetingServiceClient.getMeetingById(926L, "trace-926", AUTH_HEADER)).thenReturn(Map.of(
                "id", 926L,
                "title", "AI persisted report transcript",
                "createdAt", "2026-06-01T12:00:00Z",
                "language", "multi",
                "status", "completed"
        ));
        when(aiServiceClient.getTranscript(926L, "trace-926")).thenReturn(Map.of(
                "meeting_id", 926L,
                "transcripts", List.of(
                        Map.of(
                                "speaker", "SPEAKER_1",
                                "text", "Report row from ai persisted transcript.",
                                "start_time", 6.0d,
                                "end_time", 8.0d
                        )
                )
        ));

        byte[] report = processingService.generateMeetingReportDocx(926L, "trace-926", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("Appendix A — Transcript Evidence Preview"));
            assertTrue(content.contains("Report row from ai persisted transcript."));
        }
        verify(aiServiceClient).getTranscript(926L, "trace-926");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingReportDocx_shouldUseCanonicalPreviewWhenAiTranscriptIsCanonical() throws Exception {
        when(jobStateStore.getJobState(927L)).thenReturn(Optional.empty());
        when(meetingServiceClient.getMeetingById(927L, "trace-927", AUTH_HEADER)).thenReturn(Map.of(
                "id", 927L,
                "title", "AI canonical report transcript",
                "createdAt", "2026-06-01T12:20:00Z",
                "language", "multi",
                "status", "completed"
        ));
        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 927L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-927");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Canonical report row from ai transcript.",
                        "start_time", 6.0d,
                        "end_time", 8.0d
                )
        ));
        aiPayload.put("rawTranscripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Raw report row duplicate A.",
                        "start_time", 6.0d,
                        "end_time", 7.0d
                ),
                Map.of(
                        "speaker", "SPEAKER_2",
                        "text", "Raw report row duplicate B.",
                        "start_time", 6.2d,
                        "end_time", 7.2d
                )
        ));
        when(aiServiceClient.getTranscript(927L, "trace-927")).thenReturn(aiPayload);

        byte[] report = processingService.generateMeetingReportDocx(927L, "trace-927", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("Canonical report row from ai transcript."));
            assertTrue(content.contains("canonical-hash-927"));
            assertTrue(!content.contains("Raw report row duplicate A."));
            assertTrue(!content.contains("Raw report row duplicate B."));
        }
        verify(aiServiceClient).getTranscript(927L, "trace-927");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingReportDocx_shouldPreferAiCanonicalPreviewOverStateRowsWhenAvailable() throws Exception {
        Map<String, Object> stateRow = new HashMap<>();
        stateRow.put("speaker", "SPEAKER_1");
        stateRow.put("text", "state preview row should be hidden");
        stateRow.put("start_time", 9.0d);
        stateRow.put("end_time", 10.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(stateRow)));
        when(jobStateStore.getJobState(928L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(928L, "trace-928", AUTH_HEADER)).thenReturn(Map.of(
                "id", 928L,
                "title", "State and canonical report",
                "createdAt", "2026-06-01T12:40:00Z",
                "language", "multi",
                "status", "completed"
        ));

        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 928L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-928");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_9",
                        "text", "canonical preview row should be visible",
                        "start_time", 9.0d,
                        "end_time", 10.0d
                )
        ));
        aiPayload.put("rawTranscripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "raw preview duplicate A",
                        "start_time", 9.0d,
                        "end_time", 9.5d
                ),
                Map.of(
                        "speaker", "SPEAKER_2",
                        "text", "raw preview duplicate B",
                        "start_time", 9.1d,
                        "end_time", 10.2d
                )
        ));
        when(aiServiceClient.getTranscript(928L, "trace-928")).thenReturn(aiPayload);

        byte[] report = processingService.generateMeetingReportDocx(928L, "trace-928", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("canonical preview row should be visible"));
            assertTrue(!content.contains("state preview row should be hidden"));
            assertTrue(!content.contains("raw preview duplicate A"));
            assertTrue(!content.contains("raw preview duplicate B"));
        }
        verify(aiServiceClient).getTranscript(928L, "trace-928");
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString(), anyString(), any());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingReportDocx_shouldLimitTranscriptPreviewRowsToThirty() throws Exception {
        List<Map<String, Object>> transcriptRows = new java.util.ArrayList<>();
        for (int i = 1; i <= 35; i++) {
            transcriptRows.add(Map.of(
                    "speaker", "SPEAKER_" + (i % 3),
                    "text", "Preview sentence number " + i + " includes enough words for the preview.",
                    "start_time", (double) (i * 5),
                    "end_time", (double) (i * 5 + 2)
            ));
        }
        transcriptRows.add(Map.of(
                "speaker", "SPEAKER_DUP",
                "text", "Preview sentence number 5 includes enough words for the preview.",
                "start_time", 999.0d,
                "end_time", 1001.0d
        ));
        transcriptRows.add(Map.of(
                "speaker", "SPEAKER_SHORT",
                "text", "To have",
                "start_time", 1002.0d,
                "end_time", 1003.0d
        ));

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", transcriptRows, "analysis", Map.of("summary", "ok", "status", "COMPLETED")));
        when(jobStateStore.getJobState(924L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(924L, "trace-924", AUTH_HEADER)).thenReturn(Map.of(
                "id", 924L,
                "title", "Preview limit check",
                "createdAt", "2026-05-30T10:40:00Z",
                "language", "multi",
                "status", "completed"
        ));

        byte[] report = processingService.generateMeetingReportDocx(924L, "trace-924", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            var tables = doc.getTables();
            var appendixTable = tables.get(tables.size() - 1);
            var appendixTimes = appendixTable.getRows().stream()
                    .skip(1)
                    .map((row) -> row.getCell(1).getText().trim())
                    .collect(Collectors.toList());
            var appendixRows = appendixTable.getRows().stream()
                    .skip(1)
                    .map((row) -> row.getCell(3).getText().trim())
                    .collect(Collectors.toList());
            assertTrue(content.contains("Appendix A — Transcript Evidence Preview"));
            assertEquals(30, appendixRows.size());
            assertEquals(30, appendixTimes.size());
            assertTrue(!content.contains("To have"));
            assertTrue(!content.contains("not big problem. not a big"));
        }
    }

    @Test
    void generateMeetingReportDocx_shouldCollapseSameTextAcrossSpeakersWithinWindow() throws Exception {
        Map<String, Object> speakerOne = new HashMap<>();
        speakerOne.put("speaker", "SPEAKER_1");
        speakerOne.put("text", "The technique is very simple.");
        speakerOne.put("start_time", 10.0d);
        speakerOne.put("end_time", 12.0d);

        Map<String, Object> speakerTwo = new HashMap<>();
        speakerTwo.put("speaker", "SPEAKER_2");
        speakerTwo.put("text", "The technique is very simple.");
        speakerTwo.put("start_time", 25.0d);
        speakerTwo.put("end_time", 27.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(speakerOne, speakerTwo), "analysis", Map.of("summary", "ok", "status", "COMPLETED")));
        when(jobStateStore.getJobState(925L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(925L, "trace-925", AUTH_HEADER)).thenReturn(Map.of(
                "id", 925L,
                "title", "Speaker collapse",
                "createdAt", "2026-05-30T10:50:00Z",
                "language", "multi",
                "status", "completed"
        ));

        byte[] report = processingService.generateMeetingReportDocx(925L, "trace-925", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("The technique is very simple."));
            var tables = doc.getTables();
            var appendixTable = tables.get(tables.size() - 1);
            var appendixRows = appendixTable.getRows().stream()
                    .skip(1)
                    .map((row) -> row.getCell(3).getText().trim())
                    .collect(Collectors.toList());
            assertEquals(1, appendixRows.size());
            assertTrue(appendixRows.contains("The technique is very simple."));
        }
    }

    @Test
    void generateMeetingReportDocx_shouldUseCacheOnlyAnalysisFallbackWhenStateAnalysisMissing() throws Exception {
        Map<String, Object> transcriptRow = new HashMap<>();
        transcriptRow.put("speaker", "SPEAKER_1");
        transcriptRow.put("text", "We need to prepare the launch API checklist.");
        transcriptRow.put("start_time", 1.0d);
        transcriptRow.put("end_time", 4.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(transcriptRow)));
        when(jobStateStore.getJobState(930L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(930L, "trace-930", AUTH_HEADER)).thenReturn(Map.of(
                "id", 930L,
                "title", "Cache fallback",
                "createdAt", "2026-06-02T09:00:00Z",
                "language", "multi",
                "status", "completed"
        ));
        Map<String, Object> cacheOnlyResponse = new HashMap<>();
        cacheOnlyResponse.put("status", "completed");
        cacheOnlyResponse.put("analysisStatus", "COMPLETED");
        cacheOnlyResponse.put("cacheHit", true);
        cacheOnlyResponse.put("provider", "gemini");
        cacheOnlyResponse.put("model", "gemini-2.5-flash");
        cacheOnlyResponse.put("promptVersion", "gemini-business-v2");
        cacheOnlyResponse.put("schemaVersion", "gemini-business-v2");
        cacheOnlyResponse.put("canonicalTranscriptHash", "canonical-hash-930");
        cacheOnlyResponse.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        cacheOnlyResponse.put("analysisInputMode", "canonical");
        cacheOnlyResponse.put("lastAnalyzedAt", "2026-06-02T09:10:00Z");
        cacheOnlyResponse.put("analysis", Map.of(
                "meetingSummary", "Cached DB summary",
                "keywords", List.of("launch", "API"),
                "technicalTerms", List.of(Map.of("term", "API", "meaning", "application interface")),
                "businessActionItems", List.of(Map.of(
                        "task", "Prepare checklist",
                        "owner", "Ann",
                        "dueDate", "Friday"
                ))
        ));
        when(aiServiceClient.getSavedAnalysisCacheOnly(
                eq(930L),
                anyString(),
                anyString(),
                eq("gemini-business-v2"),
                eq("gemini-business-v2"),
                eq("trace-930"),
                eq(AUTH_HEADER)
        )).thenReturn(cacheOnlyResponse);

        byte[] report = processingService.generateMeetingReportDocx(930L, "trace-930", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("Cached DB summary"));
            assertTrue(content.contains("launch"));
            assertTrue(content.contains("API - application interface"));
            assertTrue(content.contains("Prepare checklist"));
            assertTrue(content.contains("gemini-2.5-flash"));
            assertTrue(content.contains("canonical-hash-930"));
            assertTrue(content.contains("COMPLETED"));
        }
        verify(aiServiceClient).getSavedAnalysisCacheOnly(
                eq(930L),
                anyString(),
                anyString(),
                eq("gemini-business-v2"),
                eq("gemini-business-v2"),
                eq("trace-930"),
                eq(AUTH_HEADER)
        );
        verify(aiServiceClient, never()).getAnalysis(anyLong(), anyString());
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingReportDocx_shouldGenerateTranscriptWhenCacheOnlyAnalysisMissing() throws Exception {
        Map<String, Object> transcriptRow = new HashMap<>();
        transcriptRow.put("speaker", "SPEAKER_1");
        transcriptRow.put("text", "Transcript should still export without analysis.");
        transcriptRow.put("start_time", 5.0d);
        transcriptRow.put("end_time", 7.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(transcriptRow)));
        when(jobStateStore.getJobState(931L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(931L, "trace-931", AUTH_HEADER)).thenReturn(Map.of(
                "id", 931L,
                "title", "No analysis fallback",
                "createdAt", "2026-06-02T09:20:00Z",
                "language", "multi",
                "status", "completed"
        ));
        when(aiServiceClient.getSavedAnalysisCacheOnly(
                eq(931L),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-931"),
                eq(AUTH_HEADER)
        )).thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

        byte[] report = processingService.generateMeetingReportDocx(931L, "trace-931", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("Transcript should still export without analysis."));
            assertTrue(content.contains("Analysis not available"));
            assertTrue(content.contains("NO_ANALYSIS"));
        }
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingReportDocx_shouldShowStaleMetadataWithoutPresentingCurrentAnalysis() throws Exception {
        Map<String, Object> transcriptRow = new HashMap<>();
        transcriptRow.put("speaker", "SPEAKER_1");
        transcriptRow.put("text", "The transcript changed after the last analysis.");
        transcriptRow.put("start_time", 8.0d);
        transcriptRow.put("end_time", 11.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(transcriptRow)));
        when(jobStateStore.getJobState(932L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(932L, "trace-932", AUTH_HEADER)).thenReturn(Map.of(
                "id", 932L,
                "title", "Stale fallback",
                "createdAt", "2026-06-02T09:30:00Z",
                "language", "multi",
                "status", "completed"
        ));
        when(aiServiceClient.getSavedAnalysisCacheOnly(
                eq(932L),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-932"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of(
                "status", "stale",
                "analysisStatus", "STALE",
                "cacheHit", false,
                "stale", true,
                "staleReason", "transcript_hash_changed",
                "provider", "gemini",
                "model", "gemini-2.5-flash",
                "retryAfterSeconds", 60
        ));

        byte[] report = processingService.generateMeetingReportDocx(932L, "trace-932", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("The transcript changed after the last analysis."));
            assertTrue(content.contains("Analysis not available"));
            assertTrue(content.contains("STALE"));
            assertTrue(content.contains("transcript_hash_changed"));
            assertTrue(content.contains("60"));
        }
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingReportDocx_shouldUseCompatibleStateAnalysisBeforeCacheOnlyFallback() throws Exception {
        Map<String, Object> transcriptRow = new HashMap<>();
        transcriptRow.put("speaker", "SPEAKER_1");
        transcriptRow.put("text", "State analysis is already complete.");
        transcriptRow.put("start_time", 12.0d);
        transcriptRow.put("end_time", 14.0d);

        Map<String, Object> analysis = new HashMap<>();
        analysis.put("meetingSummary", "State summary");
        analysis.put("analysisStatus", "COMPLETED");
        analysis.put("cacheHit", true);
        analysis.put("provider", "gemini");
        analysis.put("model", "gemini-2.5-flash");
        analysis.put("canonicalTranscriptHash", "state-canonical-hash");

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(transcriptRow), "analysis", analysis));
        when(jobStateStore.getJobState(933L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(933L, "trace-933", AUTH_HEADER)).thenReturn(Map.of(
                "id", 933L,
                "title", "State compatible",
                "createdAt", "2026-06-02T09:40:00Z",
                "language", "multi",
                "status", "completed"
        ));
        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 933L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-933");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Canonical sidecar row for report metadata.",
                        "start_time", 12.0d,
                        "end_time", 14.0d
                )
        ));
        when(aiServiceClient.getTranscript(933L, "trace-933")).thenReturn(aiPayload);

        byte[] report = processingService.generateMeetingReportDocx(933L, "trace-933", AUTH_HEADER);

        try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(report));
             XWPFWordExtractor extractor = new XWPFWordExtractor(doc)) {
            String content = extractor.getText();
            assertTrue(content.contains("State summary"));
            assertTrue(content.contains("state-canonical-hash"));
            assertTrue(content.contains("canonical-transcript-v1"));
            assertTrue(content.contains("canonical"));
        }
        verify(aiServiceClient).getTranscript(933L, "trace-933");
        verify(aiServiceClient, never()).getSavedAnalysisCacheOnly(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingTranscriptTxt_rawExportShouldNotFetchAnalysisCacheOnly() {
        Map<String, Object> rawRow = new HashMap<>();
        rawRow.put("speaker", "SPEAKER_1");
        rawRow.put("text", "Raw transcript export stays unchanged.");
        rawRow.put("start_time", 1.0d);
        rawRow.put("end_time", 2.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of("transcripts", List.of(rawRow)));
        when(jobStateStore.getJobState(934L)).thenReturn(Optional.of(state));
        when(meetingServiceClient.getMeetingById(934L, "trace-934", AUTH_HEADER)).thenReturn(Map.of(
                "id", 934L,
                "title", "Raw unchanged",
                "createdAt", "2026-06-02T09:50:00Z",
                "language", "multi",
                "status", "completed"
        ));

        String content = new String(
                processingService.generateMeetingTranscriptTxt(934L, "trace-934", AUTH_HEADER, "raw"),
                StandardCharsets.UTF_8
        );

        assertTrue(content.contains("Raw transcript export stays unchanged."));
        verify(aiServiceClient, never()).getSavedAnalysisCacheOnly(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void generateMeetingReportDocx_shouldRejectForbiddenMeetingAccess() {
        when(meetingServiceClient.getMeetingById(922L, "trace-922", AUTH_HEADER))
                .thenThrow(new HttpClientErrorException(HttpStatus.FORBIDDEN));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.generateMeetingReportDocx(922L, "trace-922", AUTH_HEADER)
        );

        assertEquals(HttpStatus.FORBIDDEN, ex.getStatusCode());
    }

    @Test
    void generateMeetingReportDocx_shouldReturnNotFoundWhenTranscriptAndAnalysisMissing() {
        when(jobStateStore.getJobState(923L)).thenReturn(Optional.empty());
        when(meetingServiceClient.getMeetingById(923L, "trace-923", AUTH_HEADER)).thenReturn(Map.of(
                "id", 923L,
                "title", "No data"
        ));
        when(aiServiceClient.getTranscript(923L, "trace-923")).thenReturn(Map.of(
                "meeting_id", 923L,
                "transcripts", List.of()
        ));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.generateMeetingReportDocx(923L, "trace-923", AUTH_HEADER)
        );

        assertEquals(HttpStatus.NOT_FOUND, ex.getStatusCode());
        assertEquals("Transcript is not ready yet.", ex.getReason());
        verify(aiServiceClient).getTranscript(923L, "trace-923");
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
                anyString(),
                anyString(),
                eq("trace-608"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of("status", "completed"));

        Map<String, Object> response = processingService.getAnalysis(608L, "trace-608", AUTH_HEADER);

        assertEquals("RUNNING", response.get("status"));
        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(608L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
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
    void getAnalysis_shouldMapQueuedLazyDecisionToPendingForPollingContract() {
        when(jobStateStore.getJobState(620L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(620L, "trace-620"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(aiServiceClient.getTranscript(620L, "trace-620")).thenReturn(Map.of(
                "meeting_id", 620L,
                "transcripts", List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "queued transcript row")
                )
        ));
        when(jobStateStore.tryStartAnalysis(eq(620L), anyString(), eq("get_analysis_lazy"), eq("processing_service_lazy_poll")))
                .thenReturn(new JobStateStore.AnalysisTriggerDecision(
                        false,
                        "QUEUED",
                        "queued",
                        null,
                        0,
                        null
                ));

        Map<String, Object> response = processingService.getAnalysis(620L, "trace-620", AUTH_HEADER);

        assertEquals("PENDING", response.get("status"));
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                eq(620L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-620"),
                eq(AUTH_HEADER)
        );
    }

    @Test
    void getAnalysis_shouldReturnNoAnalysisWithoutLazyEnqueueWhenFinalizedTranscriptIsEmpty() {
        when(jobStateStore.getJobState(609L)).thenReturn(Optional.of(Map.of(
                "status", "NO_TRANSCRIPT_AFTER_FINALIZE"
        )));
        when(aiServiceClient.getAnalysis(609L, "trace-609"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

        Map<String, Object> response = processingService.getAnalysis(609L, "trace-609", AUTH_HEADER);

        assertEquals(RealtimeStatusCodes.NO_TRANSCRIPT, response.get("status"));
        assertEquals("NO_ANALYSIS", response.get("analysisStatus"));
        assertEquals(RealtimeStatusCodes.NO_TRANSCRIPT, response.get("errorCode"));
        assertEquals(RealtimeStatusCodes.NO_TRANSCRIPT_AFTER_FINALIZE, response.get("legacyErrorCode"));
        assertEquals(0, response.get("transcriptRows"));
        verify(aiServiceClient, never()).getTranscript(609L, "trace-609");
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void getAnalysis_lazyPath_shouldPersistGeminiRateLimitFromAiService429() {
        when(jobStateStore.getJobState(615L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(615L, "trace-615"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(aiServiceClient.getTranscript(615L, "trace-615")).thenReturn(Map.of(
                "meeting_id", 615L,
                "transcripts", List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "rate limited transcript row")
                )
        ));
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(615L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-615"),
                eq(AUTH_HEADER)
        )).thenThrow(HttpClientErrorException.create(
                HttpStatus.TOO_MANY_REQUESTS,
                "Too Many Requests",
                new HttpHeaders(),
                """
                {
                  "error": "GEMINI_RATE_LIMITED",
                  "status": 429,
                  "details": {
                    "provider": "gemini",
                    "retryable": true,
                    "retryAfterSeconds": 7,
                    "errorCode": "GEMINI_RATE_LIMITED"
                  }
                }
                """.getBytes(StandardCharsets.UTF_8),
                StandardCharsets.UTF_8
        ));

        Map<String, Object> response = processingService.getAnalysis(615L, "trace-615", AUTH_HEADER);

        assertEquals("RUNNING", response.get("status"));
        verify(jobStateStore, timeout(1000)).markAnalysisFailed(
                eq(615L),
                anyString(),
                eq("get_analysis_lazy"),
                eq("processing_service_lazy_poll"),
                eq("lock-token"),
                eq("GEMINI_RATE_LIMITED"),
                anyString(),
                eq(7)
        );
    }

    @Test
    void getAnalysis_shouldSurfacePersistedGeminiRateLimitRetryAfter() {
        when(jobStateStore.getJobState(619L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(619L, "trace-619"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(jobStateStore.getAnalysisState(619L)).thenReturn(Optional.of(
                new JobStateStore.AnalysisStateSnapshot(
                        AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE,
                        "hash-619",
                        "get_analysis_lazy",
                        "GEMINI_RATE_LIMITED",
                        "Gemini rate limit reached",
                        System.currentTimeMillis() + 7000L,
                        7,
                        true,
                        false,
                        2,
                        "2026-06-16T10:00:00Z",
                        "trace-abc123",
                        null
                )
        ));

        Map<String, Object> response = processingService.getAnalysis(619L, "trace-619", AUTH_HEADER);

        assertEquals("RETRYABLE_FAILED", response.get("status"));
        assertEquals(AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE, response.get("analysisStatus"));
        assertEquals("GEMINI_RATE_LIMITED", response.get("errorCode"));
        assertEquals(7, response.get("retryAfterSeconds"));
        assertEquals(true, response.get("retryable"));
        assertEquals(false, response.get("retryExhausted"));
        assertEquals(2, response.get("analysisRetryCount"));
        assertEquals("2026-06-16T10:00:00Z", response.get("analysisNextRetryAt"));
        assertEquals("trace-abc123", response.get("analysisTraceId"));
        assertEquals(true, response.get("transcriptSaved"));
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                eq(619L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-619"),
                eq(AUTH_HEADER)
        );
    }

    @Test
    void getAnalysis_lazyPath_shouldUseCanonicalTranscriptWhenAvailable() {
        when(jobStateStore.getJobState(614L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(614L, "trace-614"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 614L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-614");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Canonical cleaned sentence.",
                        "start_time", 1.0d,
                        "end_time", 2.0d
                )
        ));
        aiPayload.put("rawTranscripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "raw noisy sentence.",
                        "start_time", 1.0d,
                        "end_time", 2.0d
                )
        ));
        when(aiServiceClient.getTranscript(614L, "trace-614")).thenReturn(aiPayload);
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(614L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-614"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of("status", "completed"));

        Map<String, Object> response = processingService.getAnalysis(614L, "trace-614", AUTH_HEADER);

        assertEquals("RUNNING", response.get("status"));
        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(614L),
                argThat(value -> value != null
                        && value.contains("Canonical cleaned sentence.")
                        && !value.contains("raw noisy sentence.")),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-614"),
                eq(AUTH_HEADER)
        );
    }

    @Test
    void getAnalysis_lazyPath_shouldPreferCanonicalTranscriptOverStateRowsWhenAvailable() {
        Map<String, Object> stateRow = new HashMap<>();
        stateRow.put("speaker", "SPEAKER_1");
        stateRow.put("text", "state raw sentence that should not be analyzed");
        stateRow.put("start_time", 1.0d);
        stateRow.put("end_time", 2.0d);

        Map<String, Object> state = new HashMap<>();
        state.put("status", "RUNNING");
        state.put("result", Map.of("transcripts", List.of(stateRow)));
        when(jobStateStore.getJobState(615L)).thenReturn(Optional.of(state));
        when(aiServiceClient.getAnalysis(615L, "trace-615"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 615L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-615");
        aiPayload.put("transcripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_9",
                        "text", "canonical sentence from ai sidecar",
                        "start_time", 1.0d,
                        "end_time", 2.0d
                )
        ));
        aiPayload.put("rawTranscripts", List.of(
                Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "raw noisy sentence from ai",
                        "start_time", 1.0d,
                        "end_time", 2.0d
                )
        ));
        when(aiServiceClient.getTranscript(615L, "trace-615")).thenReturn(aiPayload);
        when(aiServiceClient.analyzeRealtimeTranscript(
                eq(615L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-615"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of("status", "completed"));

        Map<String, Object> response = processingService.getAnalysis(615L, "trace-615", AUTH_HEADER);

        assertEquals("RUNNING", response.get("status"));
        verify(aiServiceClient).getTranscript(615L, "trace-615");
        verify(aiServiceClient, timeout(1000)).analyzeRealtimeTranscript(
                eq(615L),
                argThat(value -> value != null
                        && value.contains("canonical sentence from ai sidecar")
                        && !value.contains("state raw sentence that should not be analyzed")
                        && !value.contains("raw noisy sentence from ai")),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-615"),
                eq(AUTH_HEADER)
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
                anyString(),
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
                anyString(),
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
        when(jobStateStore.getAnalysisState(611L)).thenReturn(Optional.of(
                new JobStateStore.AnalysisStateSnapshot(
                        AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE,
                        "hash-611",
                        "get_analysis_lazy",
                        "GEMINI_UNAVAILABLE",
                        "Gemini unavailable",
                        System.currentTimeMillis() + 45000L,
                        45,
                        true,
                        true,
                        4,
                        null,
                        "trace-exhausted",
                        null
                )
        ));

        Map<String, Object> response = processingService.getAnalysis(611L, "trace-611", AUTH_HEADER);

        assertEquals("RETRYABLE_FAILED", response.get("status"));
        assertEquals(AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE, response.get("analysisStatus"));
        assertEquals("GEMINI_UNAVAILABLE", response.get("errorCode"));
        assertEquals(45, response.get("retryAfterSeconds"));
        assertEquals(true, response.get("retryable"));
        assertEquals(true, response.get("retryExhausted"));
        assertEquals(4, response.get("analysisRetryCount"));
        assertEquals("trace-exhausted", response.get("analysisTraceId"));
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                eq(611L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-611"),
                eq(AUTH_HEADER)
        );
        verify(aiServiceClient, never()).getTranscript(eq(611L), eq("trace-611"));
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
                anyString(),
                anyString(),
                eq("trace-612"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of(
                "status", "skipped",
                "reason", "in_progress",
                "retryAfterSeconds", 30
        ));

        Map<String, Object> response = processingService.getAnalysis(612L, "trace-612", AUTH_HEADER);

        assertEquals("RUNNING", response.get("status"));
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
                anyString(),
                anyString(),
                eq("trace-613"),
                eq(AUTH_HEADER)
        )).thenReturn(Map.of(
                "status", "skipped",
                "reason", "already_exists"
        ));

        Map<String, Object> response = processingService.getAnalysis(613L, "trace-613", AUTH_HEADER);

        assertEquals("RUNNING", response.get("status"));
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

        assertEquals("PENDING", response.get("status"));
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                eq(610L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-610"),
                eq(AUTH_HEADER)
        );
    }

    @Test
    void getAnalysis_shouldReturnSkippedEmptyTranscriptWhenPersistedRowsAreBlank() {
        when(jobStateStore.getJobState(614L)).thenReturn(Optional.empty());
        when(aiServiceClient.getAnalysis(614L, "trace-614"))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));
        when(aiServiceClient.getTranscript(614L, "trace-614")).thenReturn(Map.of(
                "meeting_id", 614L,
                "transcripts", List.of(
                        Map.of("speaker", "SPEAKER_1", "text", "   ")
                )
        ));

        Map<String, Object> response = processingService.getAnalysis(614L, "trace-614", AUTH_HEADER);

        assertEquals("SKIPPED_EMPTY_TRANSCRIPT", response.get("status"));
        verify(jobStateStore).markAnalysisSkipped(
                eq(614L),
                anyString(),
                eq("get_analysis_lazy"),
                eq("processing_service_lazy_poll"),
                isNull(),
                eq("skipped_empty_transcript"),
                eq(0)
        );
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                eq(614L),
                anyString(),
                eq("it"),
                eq("realtime"),
                anyString(),
                anyString(),
                anyString(),
                eq("trace-614"),
                eq(AUTH_HEADER)
        );
    }

    @Test
    void reanalyzeMeetingAnalysis_shouldVerifyAccessAndDelegateToAiService() {
        when(meetingServiceClient.getMeetingById(616L, "trace-616", AUTH_HEADER))
                .thenReturn(Map.of("id", 616L));
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of(
                "analysis", Map.of("summary", "Previous summary"),
                "transcripts", List.of(Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Saved transcript"
                ))
        ));
        when(jobStateStore.getJobState(616L)).thenReturn(Optional.of(state));
        when(aiServiceClient.rerunAnalysis(
                616L,
                "force",
                "manual_reanalyze",
                "SPEAKER_1: Saved transcript",
                "37575315f5e3c1689f1ccc05fc23cf21f24a317834899b0c1b0aaffb48a7f555",
                "gemini-business-v2",
                "gemini-business-v2",
                "grouped-action-plan-v1",
                null,
                null,
                null,
                "trace-616",
                AUTH_HEADER
        )).thenReturn(Map.of(
                "analysisStatus", "ANALYZING",
                "cacheHit", false,
                "retryAfterSeconds", 3
        ));

        Map<String, Object> response = processingService.reanalyzeMeetingAnalysis(
                616L,
                "force",
                "manual_reanalyze",
                "trace-616",
                AUTH_HEADER
        );

        assertEquals("ANALYZING", response.get("analysisStatus"));
        assertEquals(3, response.get("retryAfterSeconds"));
        verify(meetingServiceClient).getMeetingById(616L, "trace-616", AUTH_HEADER);
        verify(aiServiceClient).rerunAnalysis(
                616L,
                "force",
                "manual_reanalyze",
                "SPEAKER_1: Saved transcript",
                "37575315f5e3c1689f1ccc05fc23cf21f24a317834899b0c1b0aaffb48a7f555",
                "gemini-business-v2",
                "gemini-business-v2",
                "grouped-action-plan-v1",
                null,
                null,
                null,
                "trace-616",
                AUTH_HEADER
        );
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void reanalyzeMeetingAnalysis_shouldReturnClearNotFoundWhenSavedTranscriptMissing() {
        when(meetingServiceClient.getMeetingById(617L, "trace-617", AUTH_HEADER))
                .thenReturn(Map.of("id", 617L));
        when(jobStateStore.getJobState(617L)).thenReturn(Optional.empty());
        when(aiServiceClient.getTranscript(617L, "trace-617"))
                .thenReturn(Map.of("meeting_id", 617L, "transcripts", List.of()));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.reanalyzeMeetingAnalysis(
                        617L,
                        "force",
                        "manual_reanalyze",
                        "trace-617",
                        AUTH_HEADER
                )
        );

        assertEquals(HttpStatus.NOT_FOUND, ex.getStatusCode());
        assertEquals("Cannot re-analyze because saved transcript was not found.", ex.getReason());
        verify(aiServiceClient, never()).rerunAnalysis(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
    }

    @Test
    void reanalyzeMeetingAnalysis_shouldMapAiServiceNotFoundToClearDomainError() {
        when(meetingServiceClient.getMeetingById(618L, "trace-618", AUTH_HEADER))
                .thenReturn(Map.of("id", 618L));
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");
        state.put("result", Map.of(
                "transcripts", List.of(Map.of(
                        "speaker", "SPEAKER_1",
                        "text", "Saved transcript"
                ))
        ));
        when(jobStateStore.getJobState(618L)).thenReturn(Optional.of(state));
        when(aiServiceClient.rerunAnalysis(
                eq(618L),
                eq("force"),
                eq("manual_reanalyze"),
                anyString(),
                anyString(),
                eq("gemini-business-v2"),
                eq("gemini-business-v2"),
                eq("grouped-action-plan-v1"),
                isNull(),
                isNull(),
                isNull(),
                eq("trace-618"),
                eq(AUTH_HEADER)
        )).thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND, "Not Found"));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.reanalyzeMeetingAnalysis(
                        618L,
                        "force",
                        "manual_reanalyze",
                        "trace-618",
                        AUTH_HEADER
                )
        );

        assertEquals(HttpStatus.NOT_FOUND, ex.getStatusCode());
        assertEquals("Cannot re-analyze because saved transcript was not found.", ex.getReason());
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
                .thenReturn(Map.of("id", 1001L, "audioPath", "/app/uploads/a.wav", "ownerUserId", 77L));
        when(aiServiceClient.processAudio(1001L, "/app/uploads/a.wav", "legacy-meeting:1001", null, null, "vi", null, "trace-1001", AUTH_HEADER, 77L))
                .thenThrow(new HttpClientErrorException(HttpStatus.SERVICE_UNAVAILABLE, "Service Unavailable"));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.startProcessing(1001L, null, null, null, null, "vi", null, "trace-1001", AUTH_HEADER)
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
                .thenReturn(Map.of("id", 1002L, "audioPath", "/app/uploads/b.wav", "ownerUserId", 77L));
        when(aiServiceClient.processAudio(1002L, "/app/uploads/b.wav", "legacy-meeting:1002", null, null, "vi", null, "trace-1002", AUTH_HEADER, 77L))
                .thenReturn(Map.of("status", "queued"));

        Map<String, Object> state = new HashMap<>();
        state.put("status", "QUEUED");
        state.put("progress", 0);
        state.put("stage", "unknown");
        state.put("updatedAt", "2026-05-20T00:00:00Z");
        when(jobStateStore.getJobState(1002L)).thenReturn(Optional.of(state));

        var response = processingService.startProcessing(1002L, null, null, null, null, "vi", null, "trace-1002", AUTH_HEADER);

        assertEquals(1002L, response.meetingId());
        assertEquals("QUEUED", response.status());
    }

    @Test
    void startProcessing_shouldForwardExplicitUploadLanguageToAiService() {
        when(jobStateStore.claimIdempotency("legacy-meeting:2001", 2001L))
                .thenReturn(new JobStateStore.IdempotencyClaim(2001L, true));
        when(meetingServiceClient.getMeetingById(2001L, "trace-2001", AUTH_HEADER))
                .thenReturn(Map.of("id", 2001L, "audioPath", "/app/uploads/c.wav", "language", "vi", "ownerUserId", 77L));
        when(aiServiceClient.processAudio(2001L, "/app/uploads/c.wav", "legacy-meeting:2001", null, null, "en", null, "trace-2001", AUTH_HEADER, 77L))
                .thenReturn(Map.of("status", "queued"));
        when(jobStateStore.getJobState(2001L)).thenReturn(Optional.of(Map.of("status", "QUEUED", "progress", 0, "stage", "unknown")));

        processingService.startProcessing(2001L, null, null, null, null, "en", null, "trace-2001", AUTH_HEADER);

        verify(aiServiceClient).processAudio(2001L, "/app/uploads/c.wav", "legacy-meeting:2001", null, null, "en", null, "trace-2001", AUTH_HEADER, 77L);
    }

    @Test
    void startProcessing_shouldFallbackToMeetingLanguageWhenRequestLanguageMissing() {
        when(jobStateStore.claimIdempotency("legacy-meeting:2002", 2002L))
                .thenReturn(new JobStateStore.IdempotencyClaim(2002L, true));
        when(meetingServiceClient.getMeetingById(2002L, "trace-2002", AUTH_HEADER))
                .thenReturn(Map.of("id", 2002L, "audioPath", "/app/uploads/d.wav", "language", "multi", "ownerUserId", 77L));
        when(aiServiceClient.processAudio(2002L, "/app/uploads/d.wav", "legacy-meeting:2002", null, null, "multi", null, "trace-2002", AUTH_HEADER, 77L))
                .thenReturn(Map.of("status", "queued"));
        when(jobStateStore.getJobState(2002L)).thenReturn(Optional.of(Map.of("status", "QUEUED", "progress", 0, "stage", "unknown")));

        processingService.startProcessing(2002L, null, null, null, null, null, null, "trace-2002", AUTH_HEADER);

        verify(aiServiceClient).processAudio(2002L, "/app/uploads/d.wav", "legacy-meeting:2002", null, null, "multi", null, "trace-2002", AUTH_HEADER, 77L);
    }

    private static Map<String, Object> transcriptRow(String speaker, double startTime, double endTime, String text) {
        Map<String, Object> row = new HashMap<>();
        row.put("speaker", speaker);
        row.put("start_time", startTime);
        row.put("end_time", endTime);
        row.put("text", text);
        return row;
    }

    private static void assertNonDecreasingStartTimes(List<?> rows) {
        double previous = -1.0d;
        for (Object row : rows) {
            double current = transcriptStartTime(row);
            assertTrue(current >= previous, "Expected transcript row start times to be non-decreasing");
            previous = current;
        }
    }

    private static List<Double> transcriptStartTimes(List<?> rows) {
        return rows.stream()
                .map(ProcessingServiceTest::transcriptStartTime)
                .collect(Collectors.toList());
    }

    private static double transcriptStartTime(Object row) {
        Object value = ((Map<?, ?>) row).get("start_time");
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        return Double.parseDouble(String.valueOf(value));
    }

    private static int indexOfText(List<?> rows, String text) {
        for (int index = 0; index < rows.size(); index++) {
            Object value = ((Map<?, ?>) rows.get(index)).get("text");
            if (text.equals(String.valueOf(value))) {
                return index;
            }
        }
        return -1;
    }

    @Test
    void runRealtimeFinalAudioFallback_returnsUnavailableForEmptyFile() {
        MockMultipartFile file = new MockMultipartFile("file", "audio.webm", "audio/webm", new byte[0]);

        Map<String, Object> result = processingService.runRealtimeFinalAudioFallback(
                501L,
                file,
                "vi",
                "trace-501",
                AUTH_HEADER
        );

        assertEquals(RealtimeStatusCodes.FINAL_AUDIO_FALLBACK_UNAVAILABLE, result.get("status"));
        verify(aiServiceClient, never()).runFinalAudioFallback(anyLong(), anyString(), anyString(), anyString(), anyString());
    }

    @Test
    void runRealtimeFinalAudioFallback_skipsAnalysisWhenNoTranscriptRows() {
        MockMultipartFile file = new MockMultipartFile("file", "audio.webm", "audio/webm", "abc".getBytes(StandardCharsets.UTF_8));
        when(aiServiceClient.uploadAudio(any(), anyString(), eq(AUTH_HEADER)))
                .thenReturn(Map.of("audio_path", "/tmp/audio.webm"));
        when(aiServiceClient.runFinalAudioFallback(eq(502L), eq("/tmp/audio.webm"), eq("vi"), anyString(), eq(AUTH_HEADER)))
                .thenReturn(Map.of(
                        "status", "completed",
                        "transcript_count", 0,
                        "error_code", "NO_TRANSCRIPT"
                ));

        Map<String, Object> result = processingService.runRealtimeFinalAudioFallback(
                502L,
                file,
                "vi",
                "trace-502",
                AUTH_HEADER
        );

        assertEquals(RealtimeStatusCodes.NO_TRANSCRIPT, result.get("status"));
        verify(aiServiceClient, never()).analyzeRealtimeTranscript(
                anyLong(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString(),
                anyString()
        );
        verify(meetingServiceClient).updateMeetingStatus(eq(502L), eq("completed"), anyString(), eq(AUTH_HEADER));
    }
}
