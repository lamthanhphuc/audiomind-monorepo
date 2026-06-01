package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

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

    @Test
    void exportTranscript_shouldReturnReadableTxtWithAttachmentHeaders() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        byte[] payload = "txt-bytes".getBytes();

        when(processingService.generateMeetingTranscriptTxt(16L, "trace-txt", "Bearer token", "readable")).thenReturn(payload);
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserPrincipal(11L, "tester"),
                null
        ));

        ResponseEntity<?> response = controller.exportTranscript(16L, "txt", "readable", "trace-txt", "Bearer token");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("text/plain;charset=utf-8", response.getHeaders().getContentType().toString());
        assertEquals(
                "attachment; filename=\"meeting-16-transcript-readable.txt\"",
                response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION)
        );

        ByteArrayResource resource = (ByteArrayResource) response.getBody();
        assertArrayEquals(payload, resource.getByteArray());
    }

    @Test
    void exportTranscript_shouldReturnReadableCsvWithAttachmentHeaders() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        byte[] payload = "csv-bytes".getBytes();

        when(processingService.generateMeetingTranscriptCsv(17L, "trace-csv", "Bearer token", "readable")).thenReturn(payload);
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserPrincipal(11L, "tester"),
                null
        ));

        ResponseEntity<?> response = controller.exportTranscript(17L, "csv", "readable", "trace-csv", "Bearer token");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("text/csv;charset=utf-8", response.getHeaders().getContentType().toString());
        assertEquals(
                "attachment; filename=\"meeting-17-transcript-readable.csv\"",
                response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION)
        );

        ByteArrayResource resource = (ByteArrayResource) response.getBody();
        assertArrayEquals(payload, resource.getByteArray());
    }

    @Test
    void exportTranscript_shouldReturnRawTxtWithAttachmentHeaders() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        byte[] payload = "raw-txt-bytes".getBytes();

        when(processingService.generateMeetingTranscriptTxt(18L, "trace-raw-txt", "Bearer token", "raw")).thenReturn(payload);
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserPrincipal(11L, "tester"),
                null
        ));

        ResponseEntity<?> response = controller.exportTranscript(18L, "txt", "raw", "trace-raw-txt", "Bearer token");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("text/plain;charset=utf-8", response.getHeaders().getContentType().toString());
        assertEquals(
                "attachment; filename=\"meeting-18-transcript-raw.txt\"",
                response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION)
        );

        ByteArrayResource resource = (ByteArrayResource) response.getBody();
        assertArrayEquals(payload, resource.getByteArray());
    }

    @Test
    void exportTranscript_shouldReturnRawCsvWithAttachmentHeaders() {
        ProcessingService processingService = mock(ProcessingService.class);
        ProcessingController controller = new ProcessingController(processingService);
        byte[] payload = "raw-csv-bytes".getBytes();

        when(processingService.generateMeetingTranscriptCsv(19L, "trace-raw-csv", "Bearer token", "raw")).thenReturn(payload);
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserPrincipal(11L, "tester"),
                null
        ));

        ResponseEntity<?> response = controller.exportTranscript(19L, "csv", "raw", "trace-raw-csv", "Bearer token");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("text/csv;charset=utf-8", response.getHeaders().getContentType().toString());
        assertEquals(
                "attachment; filename=\"meeting-19-transcript-raw.csv\"",
                response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION)
        );

        ByteArrayResource resource = (ByteArrayResource) response.getBody();
        assertArrayEquals(payload, resource.getByteArray());
    }
}
