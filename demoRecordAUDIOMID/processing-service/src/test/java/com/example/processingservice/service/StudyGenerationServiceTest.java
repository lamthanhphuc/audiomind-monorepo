package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestClientException;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.client.UserQuotaClient;
import com.example.processingservice.client.UserQuotaClient.QuotaConsumeResult;
import com.example.processingservice.client.UserQuotaClient.QuotaConsumeStatus;

@ExtendWith(MockitoExtension.class)
class StudyGenerationServiceTest {

    @Mock
    private MeetingServiceClient meetingServiceClient;
    @Mock
    private AIServiceClient aiServiceClient;
    @Mock
    private UserQuotaClient userQuotaClient;

    @InjectMocks
    private StudyGenerationService studyGenerationService;

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(studyGenerationService, "geminiCharsPerArtifact", 8000L);
        lenient().when(userQuotaClient.authorizeFeature(anyLong(), anyString()))
                .thenReturn(new UserQuotaClient.FeatureAuthorizationResult(true, true, "PREMIUM"));
    }

    @Test
    void createArtifacts_cacheHit_skipsQuotaAndDispatch() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "artifactIds", List.of(1001),
                        "newlyCreatedArtifactIds", List.of(),
                        "cacheHitArtifactIds", List.of(1001),
                        "inFlightArtifactIds", List.of(),
                        "dispatchableArtifactIds", List.of(),
                        "status", "COMPLETED",
                        "artifacts", List.of(Map.of("id", 1001, "status", "COMPLETED", "cacheHit", true))
                ));

        Map<String, Object> result = studyGenerationService.createStudyArtifacts(
                1L,
                12L,
                List.of(101L),
                List.of("FLASHCARDS"),
                "EXPLICIT",
                Map.of("language", "vi", "flashcardCount", 20),
                null,
                false,
                "trace",
                "Bearer t");

        assertEquals("COMPLETED", result.get("status"));
        verify(userQuotaClient, never()).consume(anyLong(), anyLong(), anyLong(), any(), any());
        verify(aiServiceClient, never()).confirmStudyQuota(any(), anyString());
        verify(aiServiceClient, never()).dispatchStudyJobs(any(), anyString());
    }

    @Test
    void createArtifacts_newlyCreated_consumesQuotaPerIdWithIdempotencyKeyAndType() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "artifactIds", List.of(1002),
                        "newlyCreatedArtifactIds", List.of(1002),
                        "cacheHitArtifactIds", List.of(),
                        "inFlightArtifactIds", List.of(),
                        "dispatchableArtifactIds", List.of(),
                        "status", "QUEUED",
                        "artifacts", List.of(Map.of("id", 1002, "status", "QUEUED"))
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:1002:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:1002:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of()));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenReturn(Map.of("dispatchedArtifactIds", List.of(1002)));

        Map<String, Object> result = studyGenerationService.createStudyArtifacts(
                1L,
                12L,
                List.of(101L),
                List.of("MIND_MAP"),
                "EXPLICIT",
                Map.of(),
                null,
                false,
                "trace",
                "Bearer t");

        assertEquals("QUEUED", result.get("status"));
        verify(userQuotaClient).consume(
                1L, 0L, 8000L,
                "study-artifact:1002:quota",
                StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> confirmCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).confirmStudyQuota(confirmCaptor.capture(), eq("trace"));
        assertEquals(List.of(1002L), confirmCaptor.getValue().get("artifactIds"));
        assertEquals(List.of(), confirmCaptor.getValue().get("synthesisIds"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> dispatchCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).dispatchStudyJobs(dispatchCaptor.capture(), eq("trace"));
        assertEquals(List.of(1002L), dispatchCaptor.getValue().get("artifactIds"));
    }

    @Test
    void createArtifacts_multipleNewlyCreated_consumesOncePerIdWithDistinctKeys() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(1002, 1003),
                        "status", "QUEUED"
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:1002:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:1002:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of()));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:1003:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:1003:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of()));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));

        studyGenerationService.createStudyArtifacts(
                1L,
                12L,
                List.of(101L),
                List.of("FLASHCARDS", "MIND_MAP"),
                "EXPLICIT",
                Map.of(),
                null,
                false,
                "trace",
                "Bearer t");

        verify(userQuotaClient).consume(
                1L, 0L, 8000L, "study-artifact:1002:quota", StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT);
        verify(userQuotaClient).consume(
                1L, 0L, 8000L, "study-artifact:1003:quota", StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT);
    }

    @Test
    void createArtifacts_orphanDispatchable_skipsQuotaAndOnlyDispatches() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "artifactIds", List.of(1005),
                        "newlyCreatedArtifactIds", List.of(),
                        "dispatchableArtifactIds", List.of(1005),
                        "status", "QUEUED",
                        "artifacts", List.of(Map.of("id", 1005, "status", "QUEUED"))
                ));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenReturn(Map.of("dispatchedArtifactIds", List.of(1005)));

        studyGenerationService.createStudyArtifacts(
                1L,
                12L,
                List.of(101L),
                List.of("FLASHCARDS"),
                "EXPLICIT",
                Map.of(),
                null,
                false,
                "trace",
                "Bearer t");

        verify(userQuotaClient, never()).consume(anyLong(), anyLong(), anyLong(), any(), any());
        verify(aiServiceClient, never()).confirmStudyQuota(any(), anyString());
        verify(aiServiceClient, never()).markStudyQuotaFailed(any(), anyString());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> dispatchCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).dispatchStudyJobs(dispatchCaptor.capture(), eq("trace"));
        assertEquals(List.of(1005L), dispatchCaptor.getValue().get("artifactIds"));
    }

    @Test
    void createArtifacts_newlyCreatedPlusDispatchable_mergesDispatchIds() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(2001),
                        "dispatchableIds", List.of(1005),
                        "status", "QUEUED"
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:2001:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:2001:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of()));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));

        studyGenerationService.createStudyArtifacts(
                1L,
                12L,
                List.of(101L),
                List.of("FLASHCARDS"),
                "EXPLICIT",
                Map.of(),
                null,
                false,
                "trace",
                "Bearer t");

        verify(userQuotaClient).consume(
                1L, 0L, 8000L, "study-artifact:2001:quota", StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT);
        verify(aiServiceClient).confirmStudyQuota(any(), anyString());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> dispatchCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).dispatchStudyJobs(dispatchCaptor.capture(), eq("trace"));
        assertEquals(List.of(1005L, 2001L), dispatchCaptor.getValue().get("artifactIds"));
    }

    @Test
    void createArtifacts_quotaDenied_marksFailedAndThrows() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(1003),
                        "artifactIds", List.of(1003),
                        "status", "QUEUED"
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:1003:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.denied(
                        "study-artifact:1003:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        null,
                        "QUOTA_EXCEEDED"));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.createStudyArtifacts(
                        1L,
                        12L,
                        List.of(101L),
                        List.of("FLASHCARDS"),
                        "EXPLICIT",
                        Map.of(),
                        null,
                        false,
                        "trace",
                        "Bearer t"));
        assertEquals(HttpStatus.PAYMENT_REQUIRED, ex.getStatusCode());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> failedCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).markStudyQuotaFailed(failedCaptor.capture(), anyString());
        assertEquals(List.of(1003L), failedCaptor.getValue().get("artifactIds"));
        verify(aiServiceClient, never()).confirmStudyQuota(any(), anyString());
        verify(aiServiceClient, never()).dispatchStudyJobs(any(), anyString());
    }

    @Test
    void createArtifacts_timeoutUnknown_leavesQueuedWithoutQuotaExceeded() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(1003),
                        "status", "QUEUED"
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:1003:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.unknown(
                        "study-artifact:1003:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        "QUOTA_TRANSPORT_ERROR"));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.createStudyArtifacts(
                        1L, 12L, List.of(101L), List.of("FLASHCARDS"), "EXPLICIT",
                        Map.of(), null, false, "trace", "Bearer t"));

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatusCode());
        verify(aiServiceClient, never()).markStudyQuotaFailed(any(), anyString());
        verify(aiServiceClient, never()).confirmStudyQuota(any(), anyString());
        verify(aiServiceClient, never()).dispatchStudyJobs(any(), anyString());
    }

    @Test
    void createArtifacts_nonRetryableUnknown_leavesQueuedWithoutQuotaExceeded() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(1003),
                        "status", "QUEUED"
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:1003:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.unknown(
                        "study-artifact:1003:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        "QUOTA_CLIENT_UNCONFIGURED",
                        false));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.createStudyArtifacts(
                        1L, 12L, List.of(101L), List.of("FLASHCARDS"), "EXPLICIT",
                        Map.of(), null, false, "trace", "Bearer t"));

        assertEquals(HttpStatus.BAD_GATEWAY, ex.getStatusCode());
        assertEquals("QUOTA_CLIENT_UNCONFIGURED", ex.getReason());
        verify(aiServiceClient, never()).markStudyQuotaFailed(any(), anyString());
        verify(aiServiceClient, never()).confirmStudyQuota(any(), anyString());
        verify(aiServiceClient, never()).dispatchStudyJobs(any(), anyString());
    }

    @Test
    void createArtifacts_retrySameKey_allowedFromLedger() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(1004),
                        "status", "QUEUED"
                ));
        // First call UNKNOWN (timeout after commit on user-service), second ALLOWED from ledger.
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:1004:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.unknown(
                        "study-artifact:1004:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        "QUOTA_TRANSPORT_ERROR"))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:1004:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of("allowed", true, "status", "ALLOWED")));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));

        assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.createStudyArtifacts(
                        1L, 12L, List.of(101L), List.of("FLASHCARDS"), "EXPLICIT",
                        Map.of(), null, false, "trace", "Bearer t"));

        Map<String, Object> result = studyGenerationService.createStudyArtifacts(
                1L, 12L, List.of(101L), List.of("FLASHCARDS"), "EXPLICIT",
                Map.of(), null, false, "trace", "Bearer t");

        assertFalse(Boolean.TRUE.equals(result.get("partialQuota")));
        verify(userQuotaClient, times(2)).consume(
                1L, 0L, 8000L, "study-artifact:1004:quota", StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT);
        verify(aiServiceClient).confirmStudyQuota(any(), anyString());
        verify(aiServiceClient, never()).markStudyQuotaFailed(any(), anyString());
    }

    @Test
    void createArtifacts_mixedBatch_allowedDeniedUnknown_partialContinue() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(new java.util.HashMap<>(Map.of(
                        "newlyCreatedArtifactIds", List.of(10, 20, 30),
                        "status", "QUEUED"
                )));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:10:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:10:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of()));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:20:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.denied(
                        "study-artifact:20:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        null,
                        "QUOTA_EXCEEDED"));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:30:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.unknown(
                        "study-artifact:30:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        "QUOTA_HTTP_503"));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));

        Map<String, Object> result = studyGenerationService.createStudyArtifacts(
                1L, 12L, List.of(101L), List.of("FLASHCARDS"), "EXPLICIT",
                Map.of(), null, false, "trace", "Bearer t");

        assertEquals(true, result.get("partialQuota"));
        assertEquals("PARTIALLY_FAILED", result.get("status"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> details = (List<Map<String, Object>>) result.get("quotaDetails");
        assertEquals(3, details.size());
        assertEquals(QuotaConsumeStatus.ALLOWED.name(), details.get(0).get("quotaStatus"));
        assertEquals(QuotaConsumeStatus.DENIED.name(), details.get(1).get("quotaStatus"));
        assertEquals(QuotaConsumeStatus.UNKNOWN.name(), details.get(2).get("quotaStatus"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> failedCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).markStudyQuotaFailed(failedCaptor.capture(), eq("trace"));
        assertEquals(List.of(20L), failedCaptor.getValue().get("artifactIds"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> confirmCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).confirmStudyQuota(confirmCaptor.capture(), eq("trace"));
        assertEquals(List.of(10L), confirmCaptor.getValue().get("artifactIds"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> dispatchCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).dispatchStudyJobs(dispatchCaptor.capture(), eq("trace"));
        assertEquals(List.of(10L), dispatchCaptor.getValue().get("artifactIds"));
    }

    @Test
    void createArtifacts_dispatchFailure_returnsRetryableServiceUnavailable() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(1004),
                        "status", "QUEUED"
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:1004:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:1004:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of()));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenThrow(new RestClientException("broker down"));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.createStudyArtifacts(
                        1L,
                        12L,
                        List.of(101L),
                        List.of("FLASHCARDS"),
                        "EXPLICIT",
                        Map.of(),
                        null,
                        false,
                        "trace",
                        "Bearer t"));

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatusCode());
        verify(aiServiceClient).confirmStudyQuota(any(), anyString());
        verify(aiServiceClient, never()).markStudyQuotaFailed(any(), anyString());
    }

    /**
     * Timeout/retry may call consume again with the same idempotency key.
     * Client-level allowed=true on both calls is fine; user-service enforces once-per-key.
     */
    @Test
    void createArtifacts_timeoutRetry_sameIdempotencyKeyDoesNotDoubleChargeAtClient() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(1004),
                        "status", "QUEUED"
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:1004:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:1004:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of()));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenThrow(new RestClientException("timeout"))
                .thenReturn(Map.of("status", "ok"));

        assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.createStudyArtifacts(
                        1L, 12L, List.of(101L), List.of("FLASHCARDS"), "EXPLICIT",
                        Map.of(), null, false, "trace", "Bearer t"));

        // Client retry after timeout: same key; user-service dedupes — mock may return allowed twice.
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(1004),
                        "dispatchableArtifactIds", List.of(1004),
                        "status", "QUEUED"
                ));

        studyGenerationService.createStudyArtifacts(
                1L, 12L, List.of(101L), List.of("FLASHCARDS"), "EXPLICIT",
                Map.of(), null, false, "trace", "Bearer t");

        verify(userQuotaClient, times(2)).consume(
                1L, 0L, 8000L, "study-artifact:1004:quota", StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT);
    }

    @Test
    void createArtifacts_regenerateForce_alwaysConsumesQuota() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "artifactIds", List.of(2001),
                        "newlyCreatedArtifactIds", List.of(2001),
                        "cacheHitArtifactIds", List.of(),
                        "inFlightArtifactIds", List.of(),
                        "status", "QUEUED",
                        "artifacts", List.of(Map.of("id", 2001, "status", "QUEUED"))
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:2001:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:2001:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of()));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenReturn(Map.of("dispatchedArtifactIds", List.of(2001)));

        studyGenerationService.createStudyArtifacts(
                1L,
                12L,
                List.of(101L),
                List.of("FLASHCARDS"),
                "EXPLICIT",
                Map.of(),
                null,
                true,
                "trace",
                "Bearer t");

        verify(userQuotaClient).consume(
                1L, 0L, 8000L, "study-artifact:2001:quota", StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT);
        verify(aiServiceClient).confirmStudyQuota(any(), anyString());
        verify(aiServiceClient).dispatchStudyJobs(any(), anyString());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> prepareCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).prepareStudyArtifacts(prepareCaptor.capture(), eq("trace"));
        assertEquals(null, prepareCaptor.getValue().get("synthesisId"));
        assertEquals(true, prepareCaptor.getValue().get("force"));
    }

    @Test
    void createArtifacts_allReady_emptyMeetingIds_keepsAllReadyModeInPrepare() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L), Map.of("id", 102L)));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(3001),
                        "status", "QUEUED"
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("study-artifact:3001:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "study-artifact:3001:quota",
                        StudyGenerationService.QUOTA_TYPE_STUDY_ARTIFACT,
                        Map.of()));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));

        studyGenerationService.createStudyArtifacts(
                1L,
                12L,
                List.of(),
                List.of("FLASHCARDS"),
                "ALL_READY",
                Map.of(),
                null,
                true,
                "trace",
                "Bearer t");

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> prepareCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).prepareStudyArtifacts(prepareCaptor.capture(), eq("trace"));
        assertEquals("ALL_READY", prepareCaptor.getValue().get("sourceSelectionMode"));
        assertEquals(List.of(101L, 102L), prepareCaptor.getValue().get("meetingIds"));
        assertEquals(true, prepareCaptor.getValue().get("force"));
    }

    @Test
    void listAllSubjectMeetings_paginatesBeyondFirstPage() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(
                        Map.of("id", 101L),
                        Map.of("id", 102L),
                        Map.of("id", 103L)
                ));
        when(meetingServiceClient.getMeetingById(anyLong(), anyString(), anyString()))
                .thenAnswer(inv -> Map.of("id", inv.getArgument(0), "ownerUserId", 1L));
        when(aiServiceClient.prepareStudyArtifacts(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreatedArtifactIds", List.of(),
                        "cacheHitArtifactIds", List.of(1),
                        "artifactIds", List.of(1),
                        "status", "COMPLETED",
                        "artifacts", List.of(Map.of("id", 1, "status", "COMPLETED", "cacheHit", true))
                ));

        studyGenerationService.createStudyArtifacts(
                1L,
                12L,
                List.of(101L, 102L, 103L),
                List.of("EXAM_BRIEF"),
                "EXPLICIT",
                Map.of(),
                null,
                false,
                "trace",
                "Bearer t");

        verify(meetingServiceClient).listAllSubjectMeetings(eq(12L), anyString(), anyString());
        verify(meetingServiceClient).getMeetingById(eq(103L), anyString(), anyString());
    }

    @Test
    void getArtifact_mapsAiNotFoundForOtherOwner() {
        when(aiServiceClient.getStudyArtifact(eq(55L), eq(1L), any(), anyString()))
                .thenThrow(new org.springframework.web.client.HttpClientErrorException(
                        org.springframework.http.HttpStatus.NOT_FOUND, "not found"));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.getArtifact(55L, 1L, "trace", "Bearer t"));
        assertEquals(org.springframework.http.HttpStatus.NOT_FOUND, ex.getStatusCode());
        verify(aiServiceClient, never()).dispatchStudyJobs(any(), anyString());
    }

    @Test
    void deleteArtifact_mapsAiNotFoundForOtherOwner() {
        when(aiServiceClient.deleteStudyArtifact(eq(55L), eq(1L), anyString()))
                .thenThrow(new org.springframework.web.client.HttpClientErrorException(
                        org.springframework.http.HttpStatus.NOT_FOUND, "not found"));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.deleteArtifact(55L, 1L, "trace"));
        assertEquals(org.springframework.http.HttpStatus.NOT_FOUND, ex.getStatusCode());
    }

    @Test
    void createArtifacts_rejectsMeetingOwnedByOtherUser() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(meetingServiceClient.getMeetingById(eq(101L), anyString(), anyString()))
                .thenReturn(Map.of("id", 101, "ownerUserId", 99L));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.createStudyArtifacts(
                        1L,
                        12L,
                        List.of(101L),
                        List.of("FLASHCARDS"),
                        "EXPLICIT",
                        Map.of(),
                        null,
                        false,
                        "trace",
                        "Bearer t"));
        assertEquals(org.springframework.http.HttpStatus.FORBIDDEN, ex.getStatusCode());
        verify(aiServiceClient, never()).prepareStudyArtifacts(any(), anyString());
        verify(aiServiceClient, never()).dispatchStudyJobs(any(), anyString());
    }

    @Test
    void createSynthesis_newlyCreated_consumesConfirmsAndDispatchesWithSubjectSynthesisType() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(aiServiceClient.prepareSubjectSynthesis(any(), anyString()))
                .thenReturn(Map.of(
                        "kind", "newlyCreated",
                        "newlyCreated", List.of(Map.of("id", 77, "status", "QUEUED")),
                        "dispatchableSynthesisIds", List.of(),
                        "synthesis", Map.of("id", 77, "status", "QUEUED")
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("subject-synthesis:77:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_SUBJECT_SYNTHESIS)))
                .thenReturn(QuotaConsumeResult.allowed(
                        "subject-synthesis:77:quota",
                        StudyGenerationService.QUOTA_TYPE_SUBJECT_SYNTHESIS,
                        Map.of()));
        when(aiServiceClient.confirmStudyQuota(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));
        when(aiServiceClient.dispatchStudyJobs(any(), anyString()))
                .thenReturn(Map.of("status", "ok"));

        Map<String, Object> result = studyGenerationService.createOrGetSynthesis(
                12L, 1L, null, "ALL_READY", "vi", false, "trace", "Bearer t");

        assertEquals(false, result.get("cacheHit"));
        verify(userQuotaClient).consume(
                1L, 0L, 8000L,
                "subject-synthesis:77:quota",
                StudyGenerationService.QUOTA_TYPE_SUBJECT_SYNTHESIS);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> confirmCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).confirmStudyQuota(confirmCaptor.capture(), eq("trace"));
        assertEquals(List.of(77L), confirmCaptor.getValue().get("synthesisIds"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> dispatchCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).dispatchStudyJobs(dispatchCaptor.capture(), eq("trace"));
        assertEquals(List.of(77L), dispatchCaptor.getValue().get("synthesisIds"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> prepareCaptor = ArgumentCaptor.forClass(Map.class);
        verify(aiServiceClient).prepareSubjectSynthesis(prepareCaptor.capture(), eq("trace"));
        assertEquals("ALL_READY", prepareCaptor.getValue().get("sourceSelectionMode"));
    }

    @Test
    void createSynthesis_quotaUnknown_throwsServiceUnavailableWithoutMarkFailed() {
        when(meetingServiceClient.getSubjectById(eq(12L), anyString(), anyString()))
                .thenReturn(Map.of("id", 12));
        when(meetingServiceClient.listAllSubjectMeetings(eq(12L), anyString(), anyString()))
                .thenReturn(List.of(Map.of("id", 101L)));
        when(aiServiceClient.prepareSubjectSynthesis(any(), anyString()))
                .thenReturn(Map.of(
                        "newlyCreated", List.of(Map.of("id", 88, "status", "QUEUED"))
                ));
        when(userQuotaClient.consume(
                        eq(1L), eq(0L), eq(8000L),
                        eq("subject-synthesis:88:quota"),
                        eq(StudyGenerationService.QUOTA_TYPE_SUBJECT_SYNTHESIS)))
                .thenReturn(QuotaConsumeResult.unknown(
                        "subject-synthesis:88:quota",
                        StudyGenerationService.QUOTA_TYPE_SUBJECT_SYNTHESIS,
                        "QUOTA_TRANSPORT_ERROR"));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> studyGenerationService.createOrGetSynthesis(
                        12L, 1L, null, "ALL_READY", "vi", false, "trace", "Bearer t"));

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatusCode());
        verify(aiServiceClient, never()).markStudyQuotaFailed(any(), anyString());
        verify(aiServiceClient, never()).confirmStudyQuota(any(), anyString());
    }
}
