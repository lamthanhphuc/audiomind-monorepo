package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
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
import org.springframework.http.HttpStatus;
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
        assertTrue(content.contains("Readable transcript export generated from saved STT output. Obvious repeated fragments may be collapsed for readability. This is a best-effort readable export; full canonical transcript cleanup is planned separately. Raw export is available with mode=raw."));
        assertTrue(content.contains("[00:36–00:37] SPEAKER_1: We should finalize the launch plan."));
        assertTrue(!content.contains("[00:36–00:37] SPEAKER_2: launch plan"));
        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
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
        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
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
        verify(aiServiceClient, never()).getTranscript(anyLong(), anyString());
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
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString());
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
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString());
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
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString());
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
                                anyString(),
                                anyString(),
                                eq("trace-700"),
                                eq(AUTH_HEADER)
                );
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
        analysis.put("status", "COMPLETED");

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
            assertTrue(content.contains("This section shows a short best-effort readable preview from saved STT output. Obvious repeated fragments may be collapsed for readability; full canonical transcript cleanup is planned separately."));
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
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString());
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
            assertTrue(content.contains("This section shows a short best-effort readable preview from saved STT output. Obvious repeated fragments may be collapsed for readability; full canonical transcript cleanup is planned separately."));
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
        verify(aiServiceClient, never()).processAudio(anyLong(), anyString(), anyString(), anyString(), any(), anyString(), anyString(), anyString());
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

        assertEquals("NOT_FOUND", response.get("status"));
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
                anyString(),
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
                anyString(),
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
                anyString(),
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
