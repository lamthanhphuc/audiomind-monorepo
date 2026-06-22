package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.io.ByteArrayInputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.apache.poi.xwpf.extractor.XWPFWordExtractor;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.service.report.MeetingActionPlanData;
import com.example.processingservice.service.report.MeetingReportDocxGenerator;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;

@ExtendWith(MockitoExtension.class)
class ProcessingServiceActionPlanTest {

    private static final String AUTH_HEADER = "Bearer test-token";

    @Mock
    private AIServiceClient aiServiceClient;

    @Mock
    private MeetingServiceClient meetingServiceClient;

    @Mock
    private JobStateStore jobStateStore;

    @Mock
    private UploadValidator uploadValidator;

    private ProcessingService processingService;

    @BeforeEach
    void setUp() {
        processingService = new ProcessingService(
                aiServiceClient,
                meetingServiceClient,
                jobStateStore,
                new SimpleMeterRegistry(),
                new MeetingReportDocxGenerator());
        processingService.initMetrics();
        lenient().doNothing().when(uploadValidator).validateIfStrict(any(), any());
        ReflectionTestUtils.setField(processingService, "uploadValidator", uploadValidator);
        ReflectionTestUtils.setField(processingService, "speakerStabilizationEnabled", false);

        lenient().when(meetingServiceClient.getMeetingById(anyLong(), anyString(), anyString()))
                .thenReturn(meeting(101L));
        lenient().when(aiServiceClient.getTranscript(anyLong(), anyString()))
                .thenReturn(Map.of("transcripts", List.of()));
        lenient().when(jobStateStore.getAnalysisState(anyLong())).thenReturn(Optional.empty());
    }

    @Test
    void getMeetingActionPlan_shouldReturnSavedActionItemsWithVerifiedEvidence() {
        when(jobStateStore.getJobState(101L)).thenReturn(Optional.of(state(
                List.of(row("Speaker 1", 12.3d, 18.7d, "Scale workers for the queue before Friday.")),
                analysis(Map.of(
                        "summary", "Saved summary",
                        "domainMode", "it",
                        "provider", "gemini",
                        "model", "gemini-2.5-flash",
                        "promptVersion", "gemini-business-v2",
                        "schemaVersion", "gemini-business-v2",
                        "action_items", List.of(Map.of(
                                "task", "Scale workers",
                                "priority", "high",
                                "status", "pending",
                                "evidenceKeywords", List.of("workers", "queue"),
                                "evidenceQuote", "model quote should lose"
                        ))
                ))
        )));

        MeetingActionPlanData response = processingService.getMeetingActionPlan(101L, "trace-action", AUTH_HEADER);

        assertEquals(101L, response.meeting().meetingId());
        assertEquals("Saved summary", response.summary());
        assertEquals(1, response.actionItems().size());
        MeetingActionPlanData.ActionItem item = response.actionItems().get(0);
        assertEquals("Scale workers", item.task());
        assertEquals("high", item.priority());
        assertEquals("open", item.status());
        assertNotNull(item.evidence());
        assertEquals("Scale workers for the queue before Friday.", item.evidence().text());
        assertNotNull(response.groupedActionPlan());
        assertEquals("grouped-action-plan-v1", response.groupedActionPlan().version());
        assertEquals(1, response.groupedActionPlan().sections().size());
        assertEquals("Công việc chung", response.groupedActionPlan().sections().get(0).title());
        assertEquals("gemini", response.analysisMetadata().provider());
        assertEquals("saved", response.analysisMetadata().analysisSource());
        verify(aiServiceClient, never()).getAnalysis(anyLong(), anyString());
    }

    @Test
    void getMeetingActionPlan_shouldReturnConflictWhenSavedAnalysisIsMissing() {
        when(jobStateStore.getJobState(102L)).thenReturn(Optional.empty());

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.getMeetingActionPlan(102L, "trace-missing-analysis", AUTH_HEADER)
        );

        assertEquals(HttpStatus.CONFLICT, ex.getStatusCode());
        assertEquals("EXPORT_ANALYSIS_REQUIRED", ex.getReason());
        verify(aiServiceClient, never()).getAnalysis(anyLong(), anyString());
    }

    @Test
    void getMeetingActionPlan_shouldReturnEmptyActionItemsWhenAnalysisHasNoTasks() {
        when(jobStateStore.getJobState(103L)).thenReturn(Optional.of(state(
                List.of(),
                analysis(Map.of("summary", "Saved summary without tasks"))
        )));

        MeetingActionPlanData response = processingService.getMeetingActionPlan(103L, "trace-no-items", AUTH_HEADER);

        assertTrue(response.actionItems().isEmpty());
        assertEquals("No action items available in saved analysis", response.note());
    }

    @Test
    void getMeetingActionPlan_shouldReadLegacyStringActionItemsAndFallbackWhenTranscriptMissing() {
        when(jobStateStore.getJobState(104L)).thenReturn(Optional.of(state(
                List.of(),
                analysis(Map.of(
                        "summary", "Legacy summary",
                        "actionItems", List.of("Gửi biên bản họp cho đội kỹ thuật")
                ))
        )));

        MeetingActionPlanData response = processingService.getMeetingActionPlan(104L, "trace-legacy", AUTH_HEADER);

        assertEquals(1, response.actionItems().size());
        assertEquals("Gửi biên bản họp cho đội kỹ thuật", response.actionItems().get(0).task());
        assertEquals("No transcript evidence available.", response.actionItems().get(0).unverifiedEvidenceNote());
    }

    @Test
    void getMeetingActionPlan_shouldRejectModelEvidenceWhenSearchHasNoMatch() {
        when(jobStateStore.getJobState(105L)).thenReturn(Optional.of(state(
                List.of(row("Speaker 1", 0d, 2d, "Unrelated transcript.")),
                analysis(Map.of(
                        "summary", "Saved summary",
                        "businessActionItems", List.of(Map.of(
                                "task", "Scale workers",
                                "evidenceQuote", "Workers are blocked"
                        ))
                ))
        )));

        MeetingActionPlanData response = processingService.getMeetingActionPlan(105L, "trace-unverified", AUTH_HEADER);

        assertEquals(1, response.actionItems().size());
        assertEquals(null, response.actionItems().get(0).evidence());
        assertEquals(
                "No transcript evidence available.",
                response.actionItems().get(0).unverifiedEvidenceNote()
        );
    }

    @Test
    void generateMeetingActionPlanDocx_shouldExportNoActionItemsDocument() throws Exception {
        when(jobStateStore.getJobState(106L)).thenReturn(Optional.of(state(
                List.of(),
                analysis(Map.of("summary", "Saved summary without tasks"))
        )));

        byte[] bytes = processingService.generateMeetingActionPlanDocx(106L, "trace-docx", AUTH_HEADER);

        assertTrue(bytes.length > 0);
        String text = extractDocxText(bytes);
        assertTrue(text.contains("Meeting Action Plan"));
        assertTrue(text.contains("CÔNG VIỆC CẦN LÀM THEO NHÓM CHỨC NĂNG"));
        assertTrue(text.contains("No action items available in saved analysis"));
    }

    @Test
    void getMeetingActionPlan_shouldPropagateForbiddenBeforeReadingState() {
        when(meetingServiceClient.getMeetingById(107L, "trace-forbidden", AUTH_HEADER))
                .thenThrow(new HttpClientErrorException(HttpStatus.FORBIDDEN));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.getMeetingActionPlan(107L, "trace-forbidden", AUTH_HEADER)
        );

        assertEquals(HttpStatus.FORBIDDEN, ex.getStatusCode());
        verify(jobStateStore, never()).getJobState(107L);
    }

    @Test
    void getMeetingActionPlan_shouldIncludeCacheOnlyMetadataFromCompatiblePayload() {
        when(jobStateStore.getJobState(108L)).thenReturn(Optional.of(state(
                List.of(),
                analysis(Map.of(
                        "summary", "Cached summary",
                        "cacheHit", true,
                        "stale", true,
                        "source", "cache_only",
                        "action_items", List.of(Map.of("task", "Review stale metadata"))
                ))
        )));

        MeetingActionPlanData response = processingService.getMeetingActionPlan(108L, "trace-cache", AUTH_HEADER);

        assertEquals("cache_only", response.analysisMetadata().analysisSource());
        assertTrue(response.analysisMetadata().cacheOnly());
        assertTrue(response.analysisMetadata().stale());
    }

    private static Map<String, Object> meeting(Long id) {
        return Map.of(
                "id", id,
                "title", "Planning",
                "createdAt", "2026-06-11T00:00:00Z",
                "language", "vi",
                "status", "completed",
                "originalFileName", "meeting.webm",
                "ownerUserId", "11"
        );
    }

    private static Map<String, Object> state(List<Map<String, Object>> transcripts, Map<String, Object> analysis) {
        return Map.of(
                "status", "COMPLETED",
                "result", Map.of(
                        "transcripts", transcripts,
                        "analysis", analysis
                )
        );
    }

    private static Map<String, Object> analysis(Map<String, Object> values) {
        return new HashMap<>(values);
    }

    private static Map<String, Object> row(String speaker, double startTime, double endTime, String text) {
        Map<String, Object> row = new HashMap<>();
        row.put("speaker", speaker);
        row.put("start_time", startTime);
        row.put("end_time", endTime);
        row.put("text", text);
        return row;
    }

    private static String extractDocxText(byte[] bytes) throws Exception {
        try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(bytes));
             XWPFWordExtractor extractor = new XWPFWordExtractor(document)) {
            return extractor.getText();
        }
    }
}
