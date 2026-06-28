package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.security.UserPrincipal;
import com.example.processingservice.service.ProcessingService;
import com.example.processingservice.service.report.MeetingActionPlanData;

class ProcessingControllerActionPlanTest {

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void actionPlan_shouldRequirePrincipal() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.actionPlan(15L, "trace-15", "Bearer token")
        );

        assertEquals(HttpStatus.UNAUTHORIZED, ex.getStatusCode());
        verify(processingService, never()).getMeetingActionPlan(15L, "trace-15", "Bearer token");
    }

    @Test
    void actionPlan_shouldReturnPreviewData() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        authenticate();
        MeetingActionPlanData expected = actionPlan(16L);
        when(processingService.getMeetingActionPlan(16L, "trace-16", "Bearer token")).thenReturn(expected);

        MeetingActionPlanData response = controller.actionPlan(16L, "trace-16", "Bearer token");

        assertEquals(expected, response);
        verify(processingService).getMeetingActionPlan(16L, "trace-16", "Bearer token");
    }

    @Test
    void exportActionPlan_shouldReturnDocxWithAttachmentHeaders() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        authenticate();
        byte[] payload = "docx-bytes".getBytes();
        when(processingService.generateMeetingActionPlanDocx(17L, "trace-17", "Bearer token")).thenReturn(payload);

        ResponseEntity<?> response = controller.exportActionPlan(17L, "docx", "trace-17", "Bearer token");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                response.getHeaders().getContentType().toString()
        );
        assertEquals(
                "attachment; filename=\"meeting-17-action-plan.docx\"",
                response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION)
        );
        ByteArrayResource resource = (ByteArrayResource) response.getBody();
        assertArrayEquals(payload, resource.getByteArray());
    }

    @Test
    void exportActionPlan_shouldRejectUnsupportedFormat() {
        ProcessingController controller = new ProcessingController(mock(ProcessingService.class));
        authenticate();

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.exportActionPlan(18L, "html", "trace-18", "Bearer token")
        );

        assertEquals(HttpStatus.BAD_REQUEST, ex.getStatusCode());
    }

    private void authenticate() {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserPrincipal(11L, "tester", "USER", "FREE"),
                null
        ));
    }

    private MeetingActionPlanData actionPlan(Long meetingId) {
        return new MeetingActionPlanData(
                new MeetingActionPlanData.Meeting(
                        meetingId,
                        "Planning",
                        "2026-06-11T00:00:00Z",
                        "vi",
                        "completed",
                        "meeting.webm",
                        "11"
                ),
                "Summary",
                "it",
                List.of(),
                List.of(),
                List.of(),
                List.of(),
                "2026-06-11T00:00:00Z",
                "No action items available in saved analysis",
                new MeetingActionPlanData.GroupedActionPlan(
                        "grouped-action-plan-v1",
                        "vi",
                        "Chưa có công việc đủ rõ để phân nhóm.",
                        List.of(),
                        List.of()
                ),
                new MeetingActionPlanData.AnalysisMetadata(
                        "gemini",
                        "gemini-2.5-flash",
                        "gemini-business-v2",
                        "gemini-business-v2",
                        "saved",
                        false,
                        false,
                        null,
                        null
                )
        );
    }
}
