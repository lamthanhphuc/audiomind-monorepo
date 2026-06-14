package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.controller.dto.TranscriptSearchResponse;
import com.example.processingservice.security.UserPrincipal;
import com.example.processingservice.service.ProcessingService;

class ProcessingControllerSearchTest {

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void searchTranscript_shouldRequirePrincipal() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.searchTranscript(15L, "deadline", null, null, "trace-15", "Bearer token")
        );

        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
        verify(processingService, never()).searchTranscriptEvidenceForMeeting(
                anyLong(),
                anyString(),
                anyInt(),
                anyInt(),
                anyString(),
                anyString()
        );
    }

    @Test
    void searchTranscript_shouldForwardDefaultsWhenLimitAndContextAreMissing() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        authenticate();
        TranscriptSearchResponse expected = new TranscriptSearchResponse(
                16L,
                "deadline",
                "deadline",
                "raw",
                null,
                null,
                List.of()
        );
        when(processingService.searchTranscriptEvidenceForMeeting(
                16L,
                "deadline",
                20,
                1,
                "trace-16",
                "Bearer token"
        )).thenReturn(expected);

        TranscriptSearchResponse response = controller.searchTranscript(
                16L,
                "deadline",
                null,
                null,
                "trace-16",
                "Bearer token"
        );

        assertEquals(expected, response);
        verify(processingService).searchTranscriptEvidenceForMeeting(
                16L,
                "deadline",
                20,
                1,
                "trace-16",
                "Bearer token"
        );
    }

    @Test
    void searchTranscript_shouldClampLargeLimitAndContextBeforeForwarding() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        authenticate();
        TranscriptSearchResponse expected = new TranscriptSearchResponse(
                17L,
                "deadline",
                "deadline",
                "raw",
                null,
                null,
                List.of()
        );
        when(processingService.searchTranscriptEvidenceForMeeting(
                17L,
                "deadline",
                50,
                3,
                "trace-17",
                "Bearer token"
        )).thenReturn(expected);

        TranscriptSearchResponse response = controller.searchTranscript(
                17L,
                "deadline",
                "999",
                "999",
                "trace-17",
                "Bearer token"
        );

        assertEquals(expected, response);
        verify(processingService).searchTranscriptEvidenceForMeeting(
                17L,
                "deadline",
                50,
                3,
                "trace-17",
                "Bearer token"
        );
    }

    @Test
    void searchTranscript_shouldRejectInvalidLimitValues() {
        ProcessingController controller = new ProcessingController(mock(ProcessingService.class));
        authenticate();

        assertBadRequest(() -> controller.searchTranscript(18L, "deadline", "abc", null, "trace", "Bearer token"));
        assertBadRequest(() -> controller.searchTranscript(18L, "deadline", "0", null, "trace", "Bearer token"));
        assertBadRequest(() -> controller.searchTranscript(18L, "deadline", "-1", null, "trace", "Bearer token"));
    }

    @Test
    void searchTranscript_shouldRejectInvalidContextValues() {
        ProcessingController controller = new ProcessingController(mock(ProcessingService.class));
        authenticate();

        assertBadRequest(() -> controller.searchTranscript(19L, "deadline", null, "abc", "trace", "Bearer token"));
        assertBadRequest(() -> controller.searchTranscript(19L, "deadline", null, "-1", "trace", "Bearer token"));
    }

    private void authenticate() {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserPrincipal(11L, "tester"),
                null
        ));
    }

    private void assertBadRequest(Runnable action) {
        ResponseStatusException ex = assertThrows(ResponseStatusException.class, action::run);
        assertEquals(HttpStatus.BAD_REQUEST, ex.getStatusCode());
    }
}
