package com.example.userservice.ratelimit;

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
        properties.setGoogleOAuthPerMinute(5);
        rateLimitService = mock(HttpRateLimitService.class);
        filter = new HttpRateLimitFilter(properties, rateLimitService, new ObjectMapper());
    }

    @Test
    void limitsGoogleOAuthByClientIp() throws Exception {
        when(rateLimitService.tryConsume(anyString(), anyInt(), any(Duration.class))).thenReturn(true);
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/auth/google/callback");
        request.setRemoteAddr("203.0.113.10");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        verify(chain).doFilter(request, response);
        verify(rateLimitService).tryConsume(eq("google-oauth:203.0.113.10"), eq(5), any(Duration.class));
    }

    @Test
    void returns429ForGoogleOAuthWhenLimited() throws Exception {
        when(rateLimitService.tryConsume(anyString(), anyInt(), any(Duration.class))).thenReturn(false);
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/auth/google/link/start");
        request.setRemoteAddr("203.0.113.11");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = mock(FilterChain.class);

        filter.doFilter(request, response, chain);

        verify(chain, never()).doFilter(any(), any());
        assertEquals(429, response.getStatus());
        org.junit.jupiter.api.Assertions.assertTrue(response.getContentAsString().contains("RATE_LIMITED"));
    }
}
