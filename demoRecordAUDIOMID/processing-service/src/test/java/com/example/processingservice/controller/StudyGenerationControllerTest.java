package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import com.example.processingservice.security.UserPrincipal;
import com.example.processingservice.service.StudyGenerationService;

@ExtendWith(MockitoExtension.class)
class StudyGenerationControllerTest {

    @Mock
    private StudyGenerationService studyGenerationService;

    @InjectMocks
    private StudyGenerationController controller;

    @BeforeEach
    void setUpAuth() {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(
                        new UserPrincipal(1L, "tester", "USER", "FREE"), null));
    }

    @AfterEach
    void clearAuth() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void regenerateArtifact_allReady_passesEmptyMeetingList() {
        when(studyGenerationService.getArtifact(eq(99L), eq(1L), anyString(), anyString()))
                .thenReturn(Map.of(
                        "subjectId", 12L,
                        "artifactType", "FLASHCARDS",
                        "sourceMeetingIds", List.of(101L, 102L),
                        "sourceSelectionMode", "ALL_READY",
                        "options", Map.of("language", "vi")
                ));
        when(studyGenerationService.createStudyArtifacts(
                        anyLong(), anyLong(), any(), any(), anyString(), any(), any(), anyBoolean(), anyString(), anyString()))
                .thenReturn(Map.of("status", "QUEUED"));

        controller.regenerateArtifact(99L, null, "trace", "Bearer t");

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Long>> meetingCaptor = ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<String> modeCaptor = ArgumentCaptor.forClass(String.class);
        verify(studyGenerationService).createStudyArtifacts(
                eq(1L),
                eq(12L),
                meetingCaptor.capture(),
                eq(List.of("FLASHCARDS")),
                modeCaptor.capture(),
                eq(Map.of("language", "vi")),
                isNull(),
                eq(true),
                anyString(),
                eq("Bearer t"));
        assertEquals(List.of(), meetingCaptor.getValue());
        assertEquals("ALL_READY", modeCaptor.getValue());
    }

    @Test
    void regenerateArtifact_explicit_keepsSourceMeetingIds() {
        when(studyGenerationService.getArtifact(eq(99L), eq(1L), anyString(), anyString()))
                .thenReturn(Map.of(
                        "subjectId", 12L,
                        "artifactType", "MIND_MAP",
                        "sourceMeetingIds", List.of(101L, 102L),
                        "sourceSelectionMode", "EXPLICIT",
                        "options", Map.of()
                ));
        when(studyGenerationService.createStudyArtifacts(
                        anyLong(), anyLong(), any(), any(), anyString(), any(), any(), anyBoolean(), anyString(), anyString()))
                .thenReturn(Map.of("status", "QUEUED"));

        controller.regenerateArtifact(99L, null, "trace", "Bearer t");

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Long>> meetingCaptor = ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<String> modeCaptor = ArgumentCaptor.forClass(String.class);
        verify(studyGenerationService).createStudyArtifacts(
                eq(1L),
                eq(12L),
                meetingCaptor.capture(),
                eq(List.of("MIND_MAP")),
                modeCaptor.capture(),
                eq(Map.of()),
                isNull(),
                eq(true),
                anyString(),
                eq("Bearer t"));
        assertEquals(List.of(101L, 102L), meetingCaptor.getValue());
        assertEquals("EXPLICIT", modeCaptor.getValue());
    }

    @Test
    void regenerateSynthesis_allReady_passesEmptyMeetingList() {
        when(studyGenerationService.createOrGetSynthesis(
                        anyLong(), anyLong(), any(), anyString(), any(), anyBoolean(), anyString(), anyString()))
                .thenReturn(Map.of("id", 77, "status", "QUEUED"));

        controller.regenerateSynthesis(
                12L,
                new StudyGenerationController.SynthesisRequest(List.of(101L), "vi", "ALL_READY"),
                "trace",
                "Bearer t");

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Long>> meetingCaptor = ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<String> modeCaptor = ArgumentCaptor.forClass(String.class);
        verify(studyGenerationService).createOrGetSynthesis(
                eq(12L),
                eq(1L),
                meetingCaptor.capture(),
                modeCaptor.capture(),
                eq("vi"),
                eq(true),
                anyString(),
                eq("Bearer t"));
        assertEquals(List.of(), meetingCaptor.getValue());
        assertEquals("ALL_READY", modeCaptor.getValue());
    }

    @Test
    void regenerateSynthesis_explicit_keepsMeetingIds() {
        when(studyGenerationService.createOrGetSynthesis(
                        anyLong(), anyLong(), any(), anyString(), any(), anyBoolean(), anyString(), anyString()))
                .thenReturn(Map.of("id", 77, "status", "QUEUED"));

        controller.regenerateSynthesis(
                12L,
                new StudyGenerationController.SynthesisRequest(List.of(101L, 102L), "vi", "EXPLICIT"),
                "trace",
                "Bearer t");

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Long>> meetingCaptor = ArgumentCaptor.forClass(List.class);
        ArgumentCaptor<String> modeCaptor = ArgumentCaptor.forClass(String.class);
        verify(studyGenerationService).createOrGetSynthesis(
                eq(12L),
                eq(1L),
                meetingCaptor.capture(),
                modeCaptor.capture(),
                eq("vi"),
                eq(true),
                anyString(),
                eq("Bearer t"));
        assertEquals(List.of(101L, 102L), meetingCaptor.getValue());
        assertEquals("EXPLICIT", modeCaptor.getValue());
    }
}
