package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.client.UserQuotaClient;

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
        verify(userQuotaClient, never()).consume(anyLong(), anyLong(), anyLong());
        verify(aiServiceClient, never()).dispatchStudyJobs(any(), anyString());
    }

    @Test
    void createArtifacts_newlyCreated_consumesQuotaThenDispatch() {
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
                        "status", "QUEUED",
                        "artifacts", List.of(Map.of("id", 1002, "status", "QUEUED"))
                ));
        when(userQuotaClient.consume(eq(1L), eq(0L), eq(8000L)))
                .thenReturn(new UserQuotaClient.QuotaConsumeResult(true, Map.of(), null));
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
        verify(userQuotaClient).consume(1L, 0L, 8000L);
        verify(aiServiceClient).dispatchStudyJobs(any(), anyString());
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
        when(userQuotaClient.consume(eq(1L), eq(0L), eq(8000L)))
                .thenReturn(new UserQuotaClient.QuotaConsumeResult(false, null, "QUOTA_EXCEEDED"));

        assertThrows(ResponseStatusException.class, () -> studyGenerationService.createStudyArtifacts(
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

        verify(aiServiceClient).markStudyQuotaFailed(any(), anyString());
        verify(aiServiceClient, never()).dispatchStudyJobs(any(), anyString());
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
        when(userQuotaClient.consume(eq(1L), eq(0L), eq(8000L)))
                .thenReturn(new UserQuotaClient.QuotaConsumeResult(true, Map.of(), null));
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

        verify(userQuotaClient).consume(1L, 0L, 8000L);
        verify(aiServiceClient).dispatchStudyJobs(any(), anyString());
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
}
