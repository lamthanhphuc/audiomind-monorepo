package com.example.processingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.processingservice.config.Epic2FeatureFlags;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.server.ResponseStatusException;

class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler(new Epic2FeatureFlags());

    @Test
    void responseStatusNotFoundOnAnalysis_shouldReturnCanonicalBodyAndTraceHeader() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("X-Trace-Id", "trace-123");
        request.setRequestURI("/processing/123/analysis");

        ResponseEntity<ApiErrorResponse> response = handler.handleResponseStatus(
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Analysis not found"),
                request);

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("trace-123", response.getHeaders().getFirst("X-Trace-Id"));
        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals("ANALYSIS_NOT_READY", body.error());
        assertEquals("ANALYSIS_NOT_READY", body.errorCode());
        assertEquals("Analysis is not ready yet", body.message());
        assertEquals(404, body.status());
        assertEquals("trace-123", body.traceId());
        assertEquals("/processing/123/analysis", body.path());
        assertNotNull(body.timestamp());
        assertNotNull(body.details());
        assertEquals("123", body.details().get("meetingId"));
    }

    @Test
    void responseStatusServiceUnavailable_shouldMapToAiServiceUnavailable() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("X-Trace-Id", "trace-456");
        request.setRequestURI("/processing/start");

        ResponseEntity<ApiErrorResponse> response = handler.handleResponseStatus(
                new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "AI service unavailable"),
                request);

        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        assertEquals("AI_SERVICE_UNAVAILABLE", body.error());
        assertEquals(503, body.status());
        assertEquals("trace-456", body.traceId());
    }

    @Test
    void unexpectedException_shouldReturnInternalErrorWithoutStackTrace() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRequestURI("/processing/1/analysis");

        ResponseEntity<ApiErrorResponse> response = handler.handleUnexpected(
                new RuntimeException("token should never be exposed"),
                request);

        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, response.getStatusCode());
        assertEquals("INTERNAL_ERROR", body.error());
        assertEquals("Unexpected server error", body.message());
        assertTrue(body.traceId() != null && !body.traceId().isBlank());
    }

    @Test
    void conflictSourceMeetingsNotReady_shouldMapCanonicalErrorCode() {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("X-Trace-Id", "trace-syn");
        request.setRequestURI("/processing/subjects/1/synthesis");

        ResponseEntity<ApiErrorResponse> response = handler.handleResponseStatus(
                new ResponseStatusException(HttpStatus.CONFLICT, "SOURCE_MEETINGS_NOT_READY"),
                request);

        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("SOURCE_MEETINGS_NOT_READY", body.error());
        assertEquals("SOURCE_MEETINGS_NOT_READY", body.errorCode());
        assertEquals("Source meetings not ready", body.message());
        assertEquals("trace-syn", body.traceId());
    }
}
