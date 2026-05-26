package com.example.userservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.authentication.BadCredentialsException;

class GlobalExceptionHandlerTest {

    @Test
    void unauthorized_shouldReturnCanonicalShapeAndTraceHeader() {
        GlobalExceptionHandler handler = new GlobalExceptionHandler();
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.addHeader("X-Trace-Id", "user-trace-1");
        request.setRequestURI("/api/users/login");

        ResponseEntity<ApiErrorResponse> response = handler.handleUnauthorized(
                new BadCredentialsException("Invalid username or password"),
                request);

        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
        assertEquals("UNAUTHORIZED", body.error());
        assertEquals("user-trace-1", body.traceId());
        assertEquals("user-trace-1", response.getHeaders().getFirst("X-Trace-Id"));
    }

    @Test
    void dataAccess_shouldMapToDatabaseUnavailable() {
        GlobalExceptionHandler handler = new GlobalExceptionHandler();
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRequestURI("/api/users/profile");

        ResponseEntity<ApiErrorResponse> response = handler.handleDataAccess(
                new DataAccessResourceFailureException("db down"),
                request);

        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        assertEquals("DATABASE_UNAVAILABLE", body.error());
        assertEquals(503, body.status());
    }

    @Test
    void unexpectedException_shouldReturnInternalErrorWithoutSensitiveMessage() {
        GlobalExceptionHandler handler = new GlobalExceptionHandler();
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRequestURI("/api/users/register");

        ResponseEntity<ApiErrorResponse> response = handler.handleUnexpected(
                new RuntimeException("password=123"),
                request);

        ApiErrorResponse body = response.getBody();
        assertNotNull(body);
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, response.getStatusCode());
        assertEquals("INTERNAL_ERROR", body.error());
        assertEquals("Unexpected server error", body.message());
        assertTrue(body.traceId() != null && !body.traceId().isBlank());
    }
}
