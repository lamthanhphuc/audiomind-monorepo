package com.example.userservice.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserApiKey;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserApiKeyRepository;
import com.example.userservice.service.AuditEventService;
import jakarta.servlet.FilterChain;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Optional;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;

class ApiKeyAuthenticationFilterTest {

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void authenticatesValidApiKeyAndStoresScopeAttributes() throws Exception {
        UserApiKeyRepository keyRepository = mock(UserApiKeyRepository.class);
        UserAccountRepository userRepository = mock(UserAccountRepository.class);
        AuditEventService auditEventService = mock(AuditEventService.class);
        ApiKeyAuthenticationFilter filter = new ApiKeyAuthenticationFilter(keyRepository, userRepository, auditEventService);

        String plaintext = "am_test_secret";
        UserApiKey key = new UserApiKey();
        key.setId(7L);
        key.setUserId(42L);
        key.setScopes("read,write");
        UserAccount user = new UserAccount();
        user.setId(42L);
        user.setUsername("api-user");
        user.setRole("USER");
        user.setPlan("PRO");

        when(keyRepository.findByKeyHashAndRevokedAtIsNull(sha256Hex(plaintext))).thenReturn(Optional.of(key));
        when(userRepository.findById(42L)).thenReturn(Optional.of(user));
        when(keyRepository.save(any(UserApiKey.class))).thenAnswer(invocation -> invocation.getArgument(0));

        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/users/me");
        request.addHeader("X-API-Key", plaintext);
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = (req, res) -> {
            assertNotNull(SecurityContextHolder.getContext().getAuthentication());
            assertEquals(7L, request.getAttribute(ApiKeyAuthenticationFilter.API_KEY_ID_ATTRIBUTE));
            assertEquals("read,write", request.getAttribute(ApiKeyAuthenticationFilter.API_KEY_SCOPES_ATTRIBUTE));
        };

        filter.doFilter(request, response, chain);

        verify(keyRepository).save(key);
        verify(auditEventService).record(eq(42L), eq("API_KEY_USED"), eq("USER_API_KEY"), eq("7"), eq("API key used"), any());
    }

    private static String sha256Hex(String value) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
    }
}
