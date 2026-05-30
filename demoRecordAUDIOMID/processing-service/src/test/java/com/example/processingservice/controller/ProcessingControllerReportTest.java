package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.example.processingservice.security.UserPrincipal;
import com.example.processingservice.service.ProcessingService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.server.ResponseStatusException;

class ProcessingControllerReportTest {

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void exportReport_shouldReturnDocxWithAttachmentHeaders() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        byte[] payload = "docx-bytes".getBytes();

        when(processingService.generateMeetingReportDocx(15L, "trace-15", "Bearer token")).thenReturn(payload);
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserPrincipal(11L, "tester"),
                null
        ));

        ResponseEntity<?> response = controller.exportReport(15L, "docx", "trace-15", "Bearer token");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                response.getHeaders().getContentType().toString()
        );
        assertEquals(
                "attachment; filename=\"meeting-15-report.docx\"",
                response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION)
        );

        ByteArrayResource resource = (ByteArrayResource) response.getBody();
        assertArrayEquals(payload, resource.getByteArray());
    }

    @Test
    void exportReport_shouldRejectUnsupportedFormat() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserPrincipal(11L, "tester"),
                null
        ));

        ResponseStatusException ex = assertThrows(
                ResponseStatusException.class,
                () -> controller.exportReport(15L, "pdf", "trace-15", "Bearer token")
        );

        assertEquals(HttpStatus.BAD_REQUEST, ex.getStatusCode());
    }
}
