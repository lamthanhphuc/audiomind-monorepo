package com.example.meetingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.meetingservice.config.Epic2FeatureFlags;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;

class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler(new Epic2FeatureFlags());

    @Test
    void notFound_shouldReturnCanonicalShapeWithTraceId() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("X-Trace-Id", "meeting-trace-1");
        request.setRequestURI("/api/meetings/9999");

        ResponseEntity<ApiErrorResponse> response = handler.handleNotFound(
                new java.util.NoSuchElementException("Meeting not found: 9999"),
                request);

        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("RESOURCE_NOT_FOUND", body.error());
        assertEquals(404, body.status());
        assertEquals("meeting-trace-1", body.traceId());
        assertEquals("meeting-trace-1", response.getHeaders().getFirst("X-Trace-Id"));
        assertNotNull(body.timestamp());
    }

    @Test
    void badRequest_shouldMapToValidationError() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRequestURI("/meeting/upload");

        ResponseEntity<ApiErrorResponse> response = handler.handleBadRequest(
                new IllegalArgumentException("File is empty"),
                request);

        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
        assertEquals("VALIDATION_ERROR", body.error());
        assertEquals(400, body.status());
    }

    @Test
    void unexpectedException_shouldReturnInternalErrorAndGeneratedTraceId() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRequestURI("/meeting/internal");

        ResponseEntity<ApiErrorResponse> response = handler.handleUnexpected(
                new RuntimeException("secret should not leak"),
                request);

        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, response.getStatusCode());
        assertEquals("INTERNAL_ERROR", body.error());
        assertEquals("Unexpected server error", body.message());
        assertTrue(body.traceId() != null && !body.traceId().isBlank());
    }
}
