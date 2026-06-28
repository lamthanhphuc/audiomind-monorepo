package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.config.Epic3FeatureFlags;
import com.example.processingservice.config.Epic3PolicyLoader;
import com.example.processingservice.controller.dto.TranscriptSearchResponse;
import com.example.processingservice.service.report.MeetingActionPlanData;
import com.example.processingservice.service.report.MeetingReportDocxGenerator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
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
import org.springframework.test.util.ReflectionTestUtils;

/**
 * Epic 3 golden-path integration: upload → canonicalize → search evidence → action plan preview → DOCX export
 * using {@code meeting-golden.json}, without provider calls at export time.
 */
@ExtendWith(MockitoExtension.class)
class Epic3EndToEndIT {

    private static final long MEETING_ID = 12_345L;
    private static final String AUTH_HEADER = "Bearer epic3-token";
    private static final String TRACE_ID = "trace-epic3-golden";

    @Mock
    private AIServiceClient aiServiceClient;

    @Mock
    private MeetingServiceClient meetingServiceClient;

    @Mock
    private JobStateStore jobStateStore;

    @Mock
    private UploadValidator uploadValidator;

    private ProcessingService processingService;
    private Epic3FeatureFlags epic3FeatureFlags;
    private JsonNode goldenFixture;

    @BeforeEach
    void setUp() throws Exception {
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

        epic3FeatureFlags = new Epic3FeatureFlags();
        epic3FeatureFlags.setTranscriptQualityEnabled(true);
        epic3FeatureFlags.setDomainLexiconEnabled(true);
        epic3FeatureFlags.setEvidenceQaEnabled(true);
        epic3FeatureFlags.setSearchVerifyEnabled(true);
        epic3FeatureFlags.setExportVerifyEnabled(true);
        ReflectionTestUtils.setField(processingService, "epic3FeatureFlags", epic3FeatureFlags);

        ObjectMapper objectMapper = new ObjectMapper();
        Epic3PolicyLoader loader = new Epic3PolicyLoader(objectMapper);
        assertNotNull(loader.getPolicy());
        ReflectionTestUtils.setField(processingService, "epic3PolicyLoader", loader);

        try (InputStream input = getClass().getResourceAsStream("/fixtures/meeting-golden.json")) {
            assertNotNull(input, "meeting-golden.json fixture is required");
            goldenFixture = objectMapper.readTree(input);
        }

        lenient().when(meetingServiceClient.getMeetingById(MEETING_ID, TRACE_ID, AUTH_HEADER))
                .thenReturn(Map.of(
                        "id", MEETING_ID,
                        "title", goldenFixture.path("title").asText("Epic 3 Golden Meeting"),
                        "language", goldenFixture.path("language").asText("vi"),
                        "audioPath", "/tmp/golden.wav",
                        "ownerUserId", 1L
                ));
        lenient().when(aiServiceClient.getTranscript(anyLong(), anyString()))
                .thenReturn(Map.of("transcripts", List.of()));
        lenient().when(aiServiceClient.getTranscriptQuality(anyLong(), anyString()))
                .thenReturn(TranscriptQualityContext.empty());
        lenient().when(jobStateStore.getAnalysisState(MEETING_ID)).thenReturn(Optional.empty());
    }

    @Test
    void epic3FullPipeline_uploadCanonicalizeSearchEvidenceExport() throws Exception {
        when(aiServiceClient.processAudio(
                eq(MEETING_ID),
                anyString(),
                any(),
                any(),
                any(),
                anyString(),
                any(),
                eq(TRACE_ID),
                eq(AUTH_HEADER),
                any()))
                .thenReturn(Map.of("status", "COMPLETED", "meeting_id", MEETING_ID));
        when(aiServiceClient.uploadAudio(any(), eq(TRACE_ID), eq(AUTH_HEADER)))
                .thenReturn(Map.of(
                        "audio_path", "/tmp/golden.wav",
                        "original_filename", "golden.wav"
                ));
        when(jobStateStore.getJobState(MEETING_ID)).thenReturn(Optional.of(goldenJobState()));
        when(aiServiceClient.getTranscriptQuality(MEETING_ID, TRACE_ID))
                .thenReturn(canonicalQualityFromGolden());

        Map<String, Object> uploadResult = processingService.uploadAudio(
                new org.springframework.mock.web.MockMultipartFile(
                        "file",
                        "golden.wav",
                        "audio/wav",
                        "golden-audio".getBytes(StandardCharsets.UTF_8)
                ),
                TRACE_ID,
                AUTH_HEADER
        );
        assertNotNull(uploadResult.get("audio_path"));

        processingService.processMeeting(
                MEETING_ID,
                "/tmp/golden.wav",
                "file-golden",
                null,
                List.of(),
                "vi",
                null,
                TRACE_ID,
                AUTH_HEADER
        );

        verify(aiServiceClient, timeout(3000).atLeastOnce())
                .requestCanonicalize(eq(MEETING_ID), isNull(), eq(TRACE_ID));

        TranscriptSearchResponse search = processingService.searchTranscriptEvidenceForMeeting(
                MEETING_ID,
                "hợp đồng",
                20,
                1,
                TRACE_ID,
                AUTH_HEADER
        );
        assertFalse(search.matches().isEmpty());

        byte[] docxBytes = processingService.generateMeetingActionPlanDocx(
                MEETING_ID,
                TRACE_ID,
                AUTH_HEADER
        );
        assertTrue(docxBytes.length > 0);
    }

    @Test
    void epic3GoldenFixture_searchEvidence_previewAndExportDocx_withoutProviderCalls() throws Exception {
        when(jobStateStore.getJobState(MEETING_ID)).thenReturn(Optional.of(goldenJobState()));

        TranscriptSearchResponse search = processingService.searchTranscriptEvidenceForMeeting(
                MEETING_ID,
                "hợp đồng",
                20,
                1,
                TRACE_ID,
                AUTH_HEADER
        );

        assertFalse(search.matches().isEmpty());
        assertTrue(search.matches().stream().anyMatch(match ->
                match.text() != null && match.text().toLowerCase().contains("hợp đồng")));

        MeetingActionPlanData preview = processingService.getMeetingActionPlan(
                MEETING_ID,
                TRACE_ID,
                AUTH_HEADER
        );
        assertNotNull(preview.groupedActionPlan());
        assertFalse(preview.groupedActionPlan().sections().isEmpty());
        assertTrue(preview.groupedActionPlan().sections().stream()
                .anyMatch(section -> "Pháp lý".equals(section.title())));

        byte[] docxBytes = processingService.generateMeetingActionPlanDocx(
                MEETING_ID,
                TRACE_ID,
                AUTH_HEADER
        );
        assertTrue(docxBytes.length > 0);

        try (XWPFDocument document = new XWPFDocument(new ByteArrayInputStream(docxBytes));
                XWPFWordExtractor extractor = new XWPFWordExtractor(document)) {
            String content = extractor.getText();
            assertTrue(content.contains("CÔNG VIỆC CẦN LÀM THEO NHÓM CHỨC NĂNG"));
            assertTrue(content.contains("Pháp lý") || content.contains("Ký hợp đồng"));
        }

        verify(aiServiceClient, never()).getAnalysis(anyLong(), anyString());
    }

    @Test
    void epic3PolicyAndFlagsLoad() {
        assertTrue(epic3FeatureFlags.isTranscriptQualityEnabled());
        assertTrue(epic3FeatureFlags.isEvidenceQaEnabled());
        assertTrue(epic3FeatureFlags.isSearchVerifyEnabled());
        assertTrue(epic3FeatureFlags.isExportVerifyEnabled());
        assertTrue(epic3FeatureFlags.isDomainLexiconEnabled());
    }

    private TranscriptQualityContext canonicalQualityFromGolden() {
        List<Map<String, Object>> rows = new java.util.ArrayList<>();
        for (JsonNode row : goldenFixture.path("transcriptRows")) {
            rows.add(Map.of(
                    "speaker", row.path("speaker").asText("SPEAKER_1"),
                    "start_time", row.path("startTime").asDouble(),
                    "end_time", row.path("endTime").asDouble(),
                    "text", row.path("text").asText()
            ));
        }
        return new TranscriptQualityContext(
                "canonical-transcript-v2",
                "golden-hash-abc",
                rows,
                Map.of("segmentCount", rows.size(), "evidenceReady", true)
        );
    }

    private Map<String, Object> goldenJobState() {
        Map<String, Object> state = new HashMap<>();
        state.put("status", "COMPLETED");

        List<Map<String, Object>> transcriptRows = new java.util.ArrayList<>();
        for (JsonNode row : goldenFixture.path("transcriptRows")) {
            transcriptRows.add(Map.of(
                    "speaker", row.path("speaker").asText("SPEAKER_1"),
                    "start_time", row.path("startTime").asDouble(),
                    "end_time", row.path("endTime").asDouble(),
                    "text", row.path("text").asText()
            ));
        }

        JsonNode analysisNode = goldenFixture.path("analysis");
        Map<String, Object> analysis = new ObjectMapper().convertValue(analysisNode, Map.class);
        state.put("result", Map.of(
                "transcripts", transcriptRows,
                "analysis", analysis
        ));
        return state;
    }
}
