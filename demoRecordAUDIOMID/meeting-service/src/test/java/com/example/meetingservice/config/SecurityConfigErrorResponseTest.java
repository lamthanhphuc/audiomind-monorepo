package com.example.meetingservice.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.Mockito.mock;

import com.example.meetingservice.security.JwtAuthenticationFilter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.security.web.access.AccessDeniedHandler;

class SecurityConfigErrorResponseTest {

    private static final String TRACE_ID = "test-trace-123";

    @Test
    void authenticationEntryPoint_shouldReturnCanonical401() throws Exception {
        SecurityConfig config = new SecurityConfig(mock(JwtAuthenticationFilter.class));
        ObjectMapper objectMapper = new ObjectMapper();
        AuthenticationEntryPoint entryPoint = config.authenticationEntryPoint();

        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/meetings/999999");
        request.addHeader(TraceIdFilter.TRACE_HEADER, TRACE_ID);
        MockHttpServletResponse response = new MockHttpServletResponse();

        entryPoint.commence(request, response, new InsufficientAuthenticationException("Unauthorized"));

        assertEquals(401, response.getStatus());
        assertEquals(TRACE_ID, response.getHeader(TraceIdFilter.TRACE_HEADER));
        JsonNode body = objectMapper.readTree(response.getContentAsString());
        assertEquals("UNAUTHORIZED", body.path("error").asText());
        assertEquals("Unauthorized", body.path("message").asText());
        assertEquals(401, body.path("status").asInt());
        assertEquals(TRACE_ID, body.path("traceId").asText());
        assertEquals("/meetings/999999", body.path("path").asText());
        assertNotNull(body.path("timestamp").asText());
    }

    @Test
    void accessDeniedHandler_shouldReturnCanonical403() throws Exception {
        SecurityConfig config = new SecurityConfig(mock(JwtAuthenticationFilter.class));
        ObjectMapper objectMapper = new ObjectMapper();
        AccessDeniedHandler handler = config.accessDeniedHandler();

        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/meetings/999999");
        request.addHeader(TraceIdFilter.TRACE_HEADER, TRACE_ID);
        MockHttpServletResponse response = new MockHttpServletResponse();

        handler.handle(request, response, new AccessDeniedException("Forbidden"));

        assertEquals(403, response.getStatus());
        assertEquals(TRACE_ID, response.getHeader(TraceIdFilter.TRACE_HEADER));
        JsonNode body = objectMapper.readTree(response.getContentAsString());
        assertEquals("FORBIDDEN", body.path("error").asText());
        assertEquals("Forbidden", body.path("message").asText());
        assertEquals(403, body.path("status").asInt());
        assertEquals(TRACE_ID, body.path("traceId").asText());
        assertEquals("/meetings/999999", body.path("path").asText());
        assertNotNull(body.path("timestamp").asText());
    }
}
