package com.example.meetingservice.controller;

import com.example.meetingservice.controller.dto.PageResponse;
import com.example.meetingservice.controller.dto.SubjectMeetingResponse;
import com.example.meetingservice.service.SubjectService;
import java.time.LocalDateTime;
import java.util.List;
import java.util.NoSuchElementException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class InternalSubjectControllerTest {

    private static final String TOKEN = "internal-secret";

    private SubjectService subjectService;
    private InternalSubjectController controller;

    @BeforeEach
    void setUp() {
        subjectService = mock(SubjectService.class);
        controller = new InternalSubjectController(subjectService);
        ReflectionTestUtils.setField(controller, "internalServiceToken", TOKEN);
    }

    @Test
    void listMeetings_validTokenAndOwner_returnsItems() {
        SubjectMeetingResponse meeting = meeting(100L, 3L);
        when(subjectService.listMeetings(3L, 9L, 1, 100))
                .thenReturn(new PageResponse<>(List.of(meeting), 1, 1, 100, 1));

        PageResponse<SubjectMeetingResponse> result =
                controller.listMeetings(3L, 1, 100, TOKEN, "9");

        assertEquals(1, result.items().size());
        assertEquals(100L, result.items().getFirst().id());
        assertEquals(3L, result.items().getFirst().subjectId());
        assertEquals(1, result.totalPages());
        verify(subjectService).listMeetings(3L, 9L, 1, 100);
    }

    @Test
    void listMeetings_invalidToken_returns401() {
        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.listMeetings(3L, 1, 100, "wrong", "9"));

        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
    }

    @Test
    void listMeetings_missingToken_returns401() {
        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.listMeetings(3L, 1, 100, null, "9"));

        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
    }

    @Test
    void listMeetings_blankToken_returns401() {
        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.listMeetings(3L, 1, 100, "  ", "9"));

        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
    }

    @Test
    void listMeetings_wrongOwner_propagatesNotFound() {
        when(subjectService.listMeetings(3L, 99L, 1, 100))
                .thenThrow(new NoSuchElementException("Subject not found"));

        NoSuchElementException ex = assertThrows(
                NoSuchElementException.class,
                () -> controller.listMeetings(3L, 1, 100, TOKEN, "99"));

        assertTrue(ex.getMessage().contains("Subject not found"));
    }

    @Test
    void listMeetings_missingOwnerHeader_returns400() {
        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.listMeetings(3L, 1, 100, TOKEN, null));

        assertEquals(HttpStatus.BAD_REQUEST, ex.getStatusCode());
    }

    @Test
    void listMeetings_emptySubject_returnsEmptyPage() {
        when(subjectService.listMeetings(3L, 9L, 1, 100))
                .thenReturn(new PageResponse<>(List.of(), 0, 1, 100, 0));

        PageResponse<SubjectMeetingResponse> result =
                controller.listMeetings(3L, 1, 100, TOKEN, "9");

        assertTrue(result.items().isEmpty());
        assertEquals(0, result.total());
        assertEquals(0, result.totalPages());
    }

    @Test
    void listMeetings_pageSizeTwoWithFiveMeetings_returnsPaginationMetadata() {
        List<SubjectMeetingResponse> page1 = List.of(meeting(1L, 3L), meeting(2L, 3L));
        when(subjectService.listMeetings(3L, 9L, 1, 2))
                .thenReturn(new PageResponse<>(page1, 5, 1, 2, 3));

        PageResponse<SubjectMeetingResponse> result =
                controller.listMeetings(3L, 1, 2, TOKEN, "9");

        assertEquals(2, result.items().size());
        assertEquals(5, result.total());
        assertEquals(1, result.page());
        assertEquals(2, result.pageSize());
        assertEquals(3, result.totalPages());
        verify(subjectService).listMeetings(eq(3L), eq(9L), eq(1), eq(2));
    }

    @Test
    void listMeetings_secondPage_forwardsPageParams() {
        List<SubjectMeetingResponse> page2 = List.of(meeting(3L, 3L), meeting(4L, 3L));
        when(subjectService.listMeetings(3L, 9L, 2, 2))
                .thenReturn(new PageResponse<>(page2, 5, 2, 2, 3));

        PageResponse<SubjectMeetingResponse> result =
                controller.listMeetings(3L, 2, 2, TOKEN, "9");

        assertEquals(2, result.page());
        assertEquals(3, result.totalPages());
        assertEquals(3L, result.items().getFirst().id());
    }

    @Test
    void listMeetings_tokenNotConfigured_returns503() {
        ReflectionTestUtils.setField(controller, "internalServiceToken", "");

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.listMeetings(3L, 1, 100, TOKEN, "9"));

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, ex.getStatusCode());
    }

    @Test
    void listMeetings_nullPaginationParams_forwarded() {
        when(subjectService.listMeetings(eq(3L), eq(9L), isNull(), isNull()))
                .thenReturn(new PageResponse<>(List.of(), 0, 1, 20, 0));

        controller.listMeetings(3L, null, null, TOKEN, "9");

        verify(subjectService).listMeetings(3L, 9L, null, null);
    }

    private static SubjectMeetingResponse meeting(Long id, Long subjectId) {
        return new SubjectMeetingResponse(
                id, "Lecture " + id, "completed", "vi", LocalDateTime.now(), subjectId);
    }
}
