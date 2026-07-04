package com.example.processingservice.ratelimit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.security.Principal;
import java.time.Duration;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class HttpRateLimitFilterTest {

    private HttpRateLimitProperties properties;
    private HttpRateLimitService rateLimitService;
    private HttpRateLimitFilter filter;

    @BeforeEach
    void setUp() {
        properties = new HttpRateLimitProperties();
        properties.setEnabled(true);
        properties.setUploadPerMinute(2);
        rateLimitService = mock(HttpRateLimitService.class);
        filter = new HttpRateLimitFilter(properties, rateLimitService, new ObjectMapper());
    }

    @Test
    void allowsRequestWhenUnderLimit() throws Exception {
        when(rateLimitService.tryConsume(anyString(), anyInt(), any(Duration.class))).thenReturn(true);
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/processing/upload");
        request.setUserPrincipal((Principal) () -> "user-1");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        verify(chain).doFilter(request, response);
        verify(rateLimitService).tryConsume(eq("upload:user:user-1"), eq(2), any(Duration.class));
    }

    @Test
    void returns429WhenUploadLimitExceeded() throws Exception {
        when(rateLimitService.tryConsume(anyString(), anyInt(), any(Duration.class))).thenReturn(false);
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/processing/upload");
        request.setRemoteAddr("10.0.0.5");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        verify(chain, never()).doFilter(any(), any());
        assertEquals(429, response.getStatus());
        assertEquals("60", response.getHeader("Retry-After"));
        String body = response.getContentAsString();
        org.junit.jupiter.api.Assertions.assertTrue(body.contains("RATE_LIMITED"));
    }
}
