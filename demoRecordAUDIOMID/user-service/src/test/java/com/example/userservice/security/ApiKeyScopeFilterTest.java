package com.example.userservice.security;

import static org.junit.jupiter.api.Assertions.assertEquals;

import jakarta.servlet.FilterChain;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class ApiKeyScopeFilterTest {

    @Test
    void allowsReadScopeForGet() throws Exception {
        ApiKeyScopeFilter filter = new ApiKeyScopeFilter();
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/users/me");
        request.setAttribute(ApiKeyAuthenticationFilter.API_KEY_ID_ATTRIBUTE, 1L);
        request.setAttribute(ApiKeyAuthenticationFilter.API_KEY_SCOPES_ATTRIBUTE, "read");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = (req, res) -> response.setStatus(204);

        filter.doFilter(request, response, chain);

        assertEquals(204, response.getStatus());
    }

    @Test
    void blocksWriteWhenOnlyReadScope() throws Exception {
        ApiKeyScopeFilter filter = new ApiKeyScopeFilter();
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/workspaces/1/members");
        request.setAttribute(ApiKeyAuthenticationFilter.API_KEY_ID_ATTRIBUTE, 1L);
        request.setAttribute(ApiKeyAuthenticationFilter.API_KEY_SCOPES_ATTRIBUTE, "read");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = (req, res) -> response.setStatus(204);

        filter.doFilter(request, response, chain);

        assertEquals(403, response.getStatus());
    }
}
