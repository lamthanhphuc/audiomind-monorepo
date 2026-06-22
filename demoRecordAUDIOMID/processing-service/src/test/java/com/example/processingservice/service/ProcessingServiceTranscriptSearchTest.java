package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.controller.dto.TranscriptEvidenceMatch;
import com.example.processingservice.controller.dto.TranscriptSearchResponse;
import com.example.processingservice.service.report.MeetingReportDocxGenerator;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;

@ExtendWith(MockitoExtension.class)
class ProcessingServiceTranscriptSearchTest {

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
    private ListAppender<ILoggingEvent> logAppender;

    @BeforeEach
    void setUp() {
        processingService = new ProcessingService(
                aiServiceClient,
                meetingServiceClient,
                jobStateStore,
                new SimpleMeterRegistry(),
                new MeetingReportDocxGenerator());
        processingService.initMetrics();
        doNothing().when(uploadValidator).validateIfStrict(any(), any());
        ReflectionTestUtils.setField(processingService, "uploadValidator", uploadValidator);
        ReflectionTestUtils.setField(processingService, "speakerStabilizationEnabled", false);

        lenient().when(meetingServiceClient.getMeetingById(anyLong(), anyString(), anyString()))
                .thenReturn(Map.of("id", 1L));
    }

    @AfterEach
    void tearDown() {
        if (logAppender != null) {
            Logger logger = (Logger) LoggerFactory.getLogger(ProcessingService.class);
            logger.detachAppender(logAppender);
        }
    }

    @Test
    void searchTranscriptEvidence_shouldReturnPhraseMatchesWithContext() {
        when(jobStateStore.getJobState(101L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "We opened the planning topic."),
                row("SPEAKER_2", 2.0d, 5.0d, "The API deadline is Friday."),
                row("SPEAKER_1", 5.0d, 8.0d, "Next topic starts here.")
        ))));

        TranscriptSearchResponse response = processingService.searchTranscriptEvidenceForMeeting(
                101L,
                "API deadline",
                20,
                1,
                "trace-search",
                AUTH_HEADER
        );

        assertEquals(101L, response.meetingId());
        assertEquals("api deadline", response.normalizedQuery());
        assertEquals("raw", response.transcriptMode());
        assertEquals(1, response.matches().size());
        TranscriptEvidenceMatch match = response.matches().get(0);
        assertEquals("The API deadline is Friday.", match.text());
        assertEquals("phrase", match.matchType());
        assertEquals(1, match.contextBefore().size());
        assertEquals("We opened the planning topic.", match.contextBefore().get(0).text());
        assertEquals(1, match.contextAfter().size());
        assertEquals("Next topic starts here.", match.contextAfter().get(0).text());
    }

    @Test
    void searchTranscriptEvidence_shouldMatchVietnameseWithoutDiacriticsAndTreatQuotesAsPunctuation() {
        when(jobStateStore.getJobState(102L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 3.0d, "Chung ta chot ke hoach tuan sau."),
                row("SPEAKER_2", 3.0d, 6.0d, "Chúng ta chốt kế hoạch hôm nay.")
        ))));

        TranscriptSearchResponse response = processingService.searchTranscriptEvidenceForMeeting(
                102L,
                "\"kế hoạch\"",
                20,
                0,
                "trace-vi",
                AUTH_HEADER
        );

        assertEquals("ke hoach", response.normalizedQuery());
        assertEquals(2, response.matches().size());
        assertEquals("phrase", response.matches().get(0).matchType());
        assertTrue(response.matches().get(0).contextBefore().isEmpty());
        assertTrue(response.matches().get(0).contextAfter().isEmpty());
    }

    @Test
    void searchTranscriptEvidence_shouldReturnEmptyMatchesWhenNoSegmentMatches() {
        when(jobStateStore.getJobState(103L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "No relevant topic here.")
        ))));

        TranscriptSearchResponse response = processingService.searchTranscriptEvidenceForMeeting(
                103L,
                "deadline",
                20,
                1,
                "trace-empty",
                AUTH_HEADER
        );

        assertTrue(response.matches().isEmpty());
    }

    @Test
    void searchTranscriptEvidence_shouldPreferCanonicalTranscriptWhenAvailable() {
        when(jobStateStore.getJobState(104L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "Raw transcript mentions raw only.")
        ))));
        Map<String, Object> aiPayload = new HashMap<>();
        aiPayload.put("meeting_id", 104L);
        aiPayload.put("transcriptMode", "canonical");
        aiPayload.put("canonicalTranscriptHash", "canonical-hash-104");
        aiPayload.put("canonicalTranscriptVersion", "canonical-transcript-v1");
        aiPayload.put("transcripts", List.of(
                row("SPEAKER_2", 2.0d, 5.0d, "Canonical API deadline row.")
        ));
        aiPayload.put("rawTranscripts", List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "Raw API deadline row.")
        ));
        when(aiServiceClient.getTranscript(104L, "trace-canonical")).thenReturn(aiPayload);

        TranscriptSearchResponse response = processingService.searchTranscriptEvidenceForMeeting(
                104L,
                "canonical deadline",
                20,
                1,
                "trace-canonical",
                AUTH_HEADER
        );

        assertEquals("canonical", response.transcriptMode());
        assertEquals("canonical-hash-104", response.canonicalTranscriptHash());
        assertEquals("canonical-transcript-v1", response.canonicalTranscriptVersion());
        assertEquals(1, response.matches().size());
        assertEquals("Canonical API deadline row.", response.matches().get(0).text());
    }

    @Test
    void searchTranscriptEvidence_shouldFallbackToRawReadableRowsWhenCanonicalIsAbsent() {
        when(jobStateStore.getJobState(105L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "Raw fallback deadline row.")
        ))));

        TranscriptSearchResponse response = processingService.searchTranscriptEvidenceForMeeting(
                105L,
                "fallback deadline",
                20,
                1,
                "trace-raw",
                AUTH_HEADER
        );

        assertEquals("raw", response.transcriptMode());
        assertEquals(1, response.matches().size());
        assertEquals("Raw fallback deadline row.", response.matches().get(0).text());
    }

    @Test
    void searchTranscriptEvidence_shouldRankRepeatedKeywordDeterministicallyAndRespectLimit() {
        when(jobStateStore.getJobState(106L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "api"),
                row("SPEAKER_2", 2.0d, 4.0d, "api api api"),
                row("SPEAKER_3", 4.0d, 6.0d, "api api")
        ))));

        TranscriptSearchResponse response = processingService.searchTranscriptEvidenceForMeeting(
                106L,
                "api",
                1,
                1,
                "trace-rank",
                AUTH_HEADER
        );

        assertEquals(1, response.matches().size());
        assertEquals("api api api", response.matches().get(0).text());
        assertEquals(1, response.matches().get(0).rank());
    }

    @Test
    void searchTranscriptEvidence_shouldClampLargeLimitAndContext() {
        when(jobStateStore.getJobState(107L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 1.0d, "context one"),
                row("SPEAKER_1", 1.0d, 2.0d, "context two"),
                row("SPEAKER_1", 2.0d, 3.0d, "context three"),
                row("SPEAKER_2", 3.0d, 4.0d, "target keyword"),
                row("SPEAKER_1", 4.0d, 5.0d, "context four"),
                row("SPEAKER_1", 5.0d, 6.0d, "context five"),
                row("SPEAKER_1", 6.0d, 7.0d, "context six")
        ))));

        TranscriptSearchResponse response = processingService.searchTranscriptEvidenceForMeeting(
                107L,
                "target",
                999,
                999,
                "trace-clamp",
                AUTH_HEADER
        );

        assertEquals(1, response.matches().size());
        assertEquals(3, response.matches().get(0).contextBefore().size());
        assertEquals(3, response.matches().get(0).contextAfter().size());
    }

    @Test
    void searchTranscriptEvidence_shouldRespectShortQueryTokenBoundaries() {
        when(jobStateStore.getJobState(115L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "The team owns platform work."),
                row("SPEAKER_2", 2.0d, 4.0d, "AI is a separate token.")
        ))));

        TranscriptSearchResponse response = processingService.searchTranscriptEvidenceForMeeting(
                115L,
                "ea",
                20,
                0,
                "trace-boundary-ea",
                AUTH_HEADER
        );

        assertEquals(0, response.matches().size());

        TranscriptSearchResponse exact = processingService.searchTranscriptEvidenceForMeeting(
                115L,
                "ai",
                20,
                0,
                "trace-boundary-ai",
                AUTH_HEADER
        );

        assertEquals(1, exact.matches().size());
        assertEquals("AI is a separate token.", exact.matches().get(0).text());
    }

    @Test
    void searchTranscriptEvidence_shouldNotMatchTwoCharactersInsideEmail() {
        when(jobStateStore.getJobState(116L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "Send email FPT to the support group.")
        ))));

        TranscriptSearchResponse shortResponse = processingService.searchTranscriptEvidenceForMeeting(
                116L,
                "em",
                20,
                0,
                "trace-boundary-em",
                AUTH_HEADER
        );
        assertEquals(0, shortResponse.matches().size());

        TranscriptSearchResponse phraseResponse = processingService.searchTranscriptEvidenceForMeeting(
                116L,
                "email FPT",
                20,
                0,
                "trace-boundary-email-fpt",
                AUTH_HEADER
        );
        assertEquals(1, phraseResponse.matches().size());
        assertEquals("Send email FPT to the support group.", phraseResponse.matches().get(0).text());
    }

    @Test
    void searchTranscriptEvidence_shouldMatchVietnameseDiacriticsAndProperNouns() {
        when(jobStateStore.getJobState(117L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "Chúng ta cần chốt kế hoạch với FPT.")
        ))));

        TranscriptSearchResponse vietnamese = processingService.searchTranscriptEvidenceForMeeting(
                117L,
                "ke hoach",
                20,
                0,
                "trace-ke-hoach",
                AUTH_HEADER
        );
        assertEquals(1, vietnamese.matches().size());

        TranscriptSearchResponse properNoun = processingService.searchTranscriptEvidenceForMeeting(
                117L,
                "fpt",
                20,
                0,
                "trace-fpt",
                AUTH_HEADER
        );
        assertEquals(1, properNoun.matches().size());
    }

    @Test
    void searchTranscriptEvidence_shouldTruncateMatchAndContextTextOnlyInResponse() {
        String longMatch = "deadline " + "m".repeat(850);
        String longContext = "context " + "c".repeat(450);
        when(jobStateStore.getJobState(108L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, longContext),
                row("SPEAKER_2", 2.0d, 4.0d, longMatch)
        ))));

        TranscriptSearchResponse response = processingService.searchTranscriptEvidenceForMeeting(
                108L,
                "deadline",
                20,
                1,
                "trace-truncate",
                AUTH_HEADER
        );

        TranscriptEvidenceMatch match = response.matches().get(0);
        assertEquals(800, match.text().length());
        assertTrue(match.textTruncated());
        assertEquals(400, match.contextBefore().get(0).text().length());
        assertTrue(match.contextBefore().get(0).textTruncated());
    }

    @Test
    void searchTranscriptEvidence_shouldRejectEmptyAndOneCharacterQueries() {
        ResponseStatusException empty = assertThrows(
                ResponseStatusException.class,
                () -> processingService.searchTranscriptEvidenceForMeeting(109L, "  ", 20, 1, "trace-empty-q", AUTH_HEADER)
        );
        ResponseStatusException shortQuery = assertThrows(
                ResponseStatusException.class,
                () -> processingService.searchTranscriptEvidenceForMeeting(109L, "a", 20, 1, "trace-short-q", AUTH_HEADER)
        );

        assertEquals(HttpStatus.BAD_REQUEST, empty.getStatusCode());
        assertEquals("QUERY_TOO_SHORT", empty.getReason());
        assertEquals(HttpStatus.BAD_REQUEST, shortQuery.getStatusCode());
        assertEquals("QUERY_TOO_SHORT", shortQuery.getReason());
    }

    @Test
    void searchTranscriptEvidence_shouldRejectInvalidLimitAndContextValues() {
        ResponseStatusException invalidLimit = assertThrows(
                ResponseStatusException.class,
                () -> processingService.searchTranscriptEvidenceForMeeting(110L, "deadline", 0, 1, "trace-limit", AUTH_HEADER)
        );
        ResponseStatusException invalidContext = assertThrows(
                ResponseStatusException.class,
                () -> processingService.searchTranscriptEvidenceForMeeting(110L, "deadline", 20, -1, "trace-context", AUTH_HEADER)
        );

        assertEquals(HttpStatus.BAD_REQUEST, invalidLimit.getStatusCode());
        assertEquals("INVALID_SEARCH_LIMIT", invalidLimit.getReason());
        assertEquals(HttpStatus.BAD_REQUEST, invalidContext.getStatusCode());
        assertEquals("INVALID_SEARCH_CONTEXT", invalidContext.getReason());
    }

    @Test
    void searchTranscriptEvidence_shouldPropagateForbiddenAccessBeforeLoadingTranscript() {
        when(meetingServiceClient.getMeetingById(111L, "trace-forbidden", AUTH_HEADER))
                .thenThrow(new HttpClientErrorException(HttpStatus.FORBIDDEN));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.searchTranscriptEvidenceForMeeting(
                        111L,
                        "deadline",
                        20,
                        1,
                        "trace-forbidden",
                        AUTH_HEADER
                )
        );

        assertEquals(HttpStatus.FORBIDDEN, ex.getStatusCode());
        verify(jobStateStore, never()).getJobState(111L);
        verify(aiServiceClient, never()).getTranscript(111L, "trace-forbidden");
    }

    @Test
    void searchTranscriptEvidence_shouldPropagateUnknownMeetingAsNotFound() {
        when(meetingServiceClient.getMeetingById(112L, "trace-missing", AUTH_HEADER))
                .thenThrow(new HttpClientErrorException(HttpStatus.NOT_FOUND));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.searchTranscriptEvidenceForMeeting(
                        112L,
                        "deadline",
                        20,
                        1,
                        "trace-missing",
                        AUTH_HEADER
                )
        );

        assertEquals(HttpStatus.NOT_FOUND, ex.getStatusCode());
    }

    @Test
    void searchTranscriptEvidence_shouldReturnNotFoundWhenTranscriptIsMissing() {
        when(jobStateStore.getJobState(113L)).thenReturn(Optional.empty());
        when(aiServiceClient.getTranscript(113L, "trace-no-transcript"))
                .thenReturn(Map.of("meeting_id", 113L, "transcripts", List.of()));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> processingService.searchTranscriptEvidenceForMeeting(
                        113L,
                        "deadline",
                        20,
                        1,
                        "trace-no-transcript",
                        AUTH_HEADER
                )
        );

        assertEquals(HttpStatus.NOT_FOUND, ex.getStatusCode());
    }

    @Test
    void searchTranscriptEvidence_shouldLogOnlySafeQueryMetadata() {
        attachLogAppender();
        when(jobStateStore.getJobState(114L)).thenReturn(Optional.of(stateWithRows(List.of(
                row("SPEAKER_1", 0.0d, 2.0d, "deadline transcript snippet must stay out of logs")
        ))));

        processingService.searchTranscriptEvidenceForMeeting(
                114L,
                "deadline secret query",
                20,
                1,
                "trace-log",
                AUTH_HEADER
        );

        String logs = logAppender.list.stream()
                .map(ILoggingEvent::getFormattedMessage)
                .reduce("", (left, right) -> left + "\n" + right);
        assertTrue(logs.contains("event=TRANSCRIPT_SEARCH_REQUEST"));
        assertTrue(logs.contains("queryLength=21"));
        assertTrue(logs.contains("queryHashPrefix="));
        assertFalse(logs.contains("deadline secret query"));
        assertFalse(logs.contains("deadline transcript snippet must stay out of logs"));
        assertFalse(logs.contains(AUTH_HEADER));
    }

    private void attachLogAppender() {
        Logger logger = (Logger) LoggerFactory.getLogger(ProcessingService.class);
        logAppender = new ListAppender<>();
        logAppender.start();
        logger.addAppender(logAppender);
        logger.setLevel(Level.INFO);
    }

    private static Map<String, Object> stateWithRows(List<Map<String, Object>> rows) {
        return Map.of(
                "status", "COMPLETED",
                "result", Map.of("transcripts", rows)
        );
    }

    private static Map<String, Object> row(String speaker, double startTime, double endTime, String text) {
        Map<String, Object> row = new HashMap<>();
        row.put("speaker", speaker);
        row.put("start_time", startTime);
        row.put("end_time", endTime);
        row.put("text", text);
        return row;
    }
}
