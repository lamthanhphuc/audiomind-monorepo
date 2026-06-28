package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.security.UserPrincipal;
import com.example.processingservice.service.ProcessingService;

class ProcessingControllerChatTest {

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void meetingChat_shouldRequirePrincipal() {
        ProcessingController controller = new ProcessingController(mock(ProcessingService.class));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.meetingChat(3L, Map.of("question", "Ai noi gi?"), "trace", "Bearer token")
        );

        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
    }

    @Test
    void meetingChat_shouldForwardQuestion() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        authenticate();
        Map<String, Object> expected = Map.of(
                "answer", "Phuc — nguon 00:15:22",
                "source_segments", List.of(Map.of("speaker", "Phuc", "startTime", 922.0))
        );
        when(processingService.answerMeetingChat(
                eq(3L),
                eq("deadline la gi?"),
                anyString(),
                eq("Bearer token")
        )).thenReturn(expected);

        Map<String, Object> response = controller.meetingChat(
                3L,
                Map.of("question", "deadline la gi?"),
                "trace-chat",
                "Bearer token"
        );

        assertEquals(expected, response);
    }

    @Test
    void semanticSearch_shouldRequirePrincipal() {
        ProcessingController controller = new ProcessingController(mock(ProcessingService.class));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.semanticSearch(Map.of("query", "API"), "10", "trace", "Bearer token")
        );

        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
    }

    @Test
    void semanticSearch_shouldForwardQuery() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        authenticate();
        Map<String, Object> expected = Map.of("query", "API", "results", List.of());
        when(processingService.semanticSearchMeetings("API", 10, "trace-semantic", "Bearer token"))
                .thenReturn(expected);

        Map<String, Object> response = controller.semanticSearch(
                Map.of("query", "API"),
                "10",
                "trace-semantic",
                "Bearer token"
        );

        assertEquals(expected, response);
        verify(processingService).semanticSearchMeetings("API", 10, "trace-semantic", "Bearer token");
    }

    @Test
    void askCrossMeeting_shouldRequirePrincipal() {
        ProcessingController controller = new ProcessingController(mock(ProcessingService.class));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.askCrossMeeting(Map.of("question", "API?"), "5", "trace", "Bearer token")
        );

        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
    }

    @Test
    void askCrossMeeting_shouldForwardQuestion() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        authenticate();
        Map<String, Object> expected = Map.of("question", "API?", "answer", "ok", "meetings", List.of());
        when(processingService.askCrossMeeting("API?", 5, "trace-cross", "Bearer token")).thenReturn(expected);

        Map<String, Object> response = controller.askCrossMeeting(
                Map.of("question", "API?"),
                "5",
                "trace-cross",
                "Bearer token"
        );

        assertEquals(expected, response);
        verify(processingService).askCrossMeeting("API?", 5, "trace-cross", "Bearer token");
    }

    private void authenticate() {
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(new UserPrincipal(11L, "tester", "USER", "FREE"), null)
        );
    }
}
