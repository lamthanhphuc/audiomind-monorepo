package com.example.userservice.service;

import com.example.userservice.client.PendingMeetingShareClient;
import com.example.userservice.controller.dto.AuthResponse;
import com.example.userservice.controller.dto.LoginRequest;
import com.example.userservice.controller.dto.RegisterRequest;
import com.example.userservice.controller.dto.RegisterResponse;
import com.example.userservice.controller.dto.UserProfileResponse;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.security.JwtUtil;
import com.example.userservice.security.TokenBlacklistStore;
import com.example.userservice.security.UserPrincipal;
import io.jsonwebtoken.Claims;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class UserServiceTest {

    @Mock
    private UserAccountRepository userAccountRepository;

    @Mock
    private PasswordEncoder passwordEncoder;

    @Mock
    private JwtUtil jwtUtil;

    @Mock
    private TokenBlacklistStore tokenBlacklistStore;

    @Mock
    private PendingMeetingShareClient pendingMeetingShareClient;

    @InjectMocks
    private UserService userService;

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(userService, "accessExpirationSeconds", 3600L);
    }

    @Test
    void register_shouldCreateUserWhenUsernameAndEmailAvailable() {
        RegisterRequest request = new RegisterRequest("alice", "P@ssw0rd!", "alice@example.com");

        when(userAccountRepository.existsByUsername("alice")).thenReturn(false);
        when(userAccountRepository.existsByEmail("alice@example.com")).thenReturn(false);
        when(passwordEncoder.encode("P@ssw0rd!")).thenReturn("HASHED");

        UserAccount saved = new UserAccount();
        saved.setId(11L);
        saved.setEmail("alice@example.com");
        when(userAccountRepository.save(any(UserAccount.class))).thenReturn(saved);

        RegisterResponse response = userService.register(request);

        assertEquals(11L, response.userId());
        verify(pendingMeetingShareClient).acceptPendingInvites(11L, "alice@example.com");
        ArgumentCaptor<UserAccount> captor = ArgumentCaptor.forClass(UserAccount.class);
        verify(userAccountRepository).save(captor.capture());
        assertEquals("alice", captor.getValue().getUsername());
        assertEquals("alice@example.com", captor.getValue().getEmail());
        assertEquals("HASHED", captor.getValue().getPasswordHash());
    }

    @Test
    void login_shouldThrowWhenPasswordMismatch() {
        LoginRequest request = new LoginRequest("bob", "wrong-pass");
        UserAccount user = new UserAccount();
        user.setId(12L);
        user.setUsername("bob");
        user.setPasswordHash("EXPECTED-HASH");

        when(userAccountRepository.findByUsername("bob")).thenReturn(Optional.of(user));
        when(passwordEncoder.matches("wrong-pass", "EXPECTED-HASH")).thenReturn(false);

        assertThrows(BadCredentialsException.class, () -> userService.login(request));
        verify(pendingMeetingShareClient, never()).acceptPendingInvites(any(), any());
    }

    @Test
    void login_shouldRejectGoogleOnlyUserWithoutPassword() {
        LoginRequest request = new LoginRequest("google_user", "any-password");
        UserAccount user = new UserAccount();
        user.setId(14L);
        user.setUsername("google_user");
        user.setPasswordHash(null);

        when(userAccountRepository.findByUsername("google_user")).thenReturn(Optional.of(user));

        assertThrows(BadCredentialsException.class, () -> userService.login(request));
        verify(pendingMeetingShareClient, never()).acceptPendingInvites(any(), any());
    }

    @Test
    void login_shouldReturnAuthResponseWhenCredentialsValid() {
        LoginRequest request = new LoginRequest("charlie", "good-pass");
        UserAccount user = new UserAccount();
        user.setId(13L);
        user.setUsername("charlie");
        user.setEmail("charlie@example.com");
        user.setPasswordHash("HASH");

        when(userAccountRepository.findByUsername("charlie")).thenReturn(Optional.of(user));
        when(passwordEncoder.matches("good-pass", "HASH")).thenReturn(true);
        when(jwtUtil.createAccessToken(13L, "charlie", "USER", "FREE")).thenReturn("token-123");

        AuthResponse response = userService.login(request);

        assertEquals(13L, response.userId());
        assertEquals("token-123", response.accessToken());
        assertEquals(3600L, response.expiresInSeconds());
        verify(pendingMeetingShareClient).acceptPendingInvites(13L, "charlie@example.com");
    }

    @Test
    void logout_shouldBlacklistTokenWithRemainingTtl() {
        String bearer = "Bearer access-token";
        Claims claims = org.mockito.Mockito.mock(Claims.class);

        when(jwtUtil.parseClaims("access-token")).thenReturn(claims);
        when(claims.getSubject()).thenReturn("21");
        when(jwtUtil.remainingTtlSeconds("access-token")).thenReturn(59L);

        userService.logout(bearer);

        verify(tokenBlacklistStore).blacklist("access-token", 59L);
    }

    @Test
    void refreshAccessToken_shouldIssueTokenFromDatabasePlan() {
        UserPrincipal principal = new UserPrincipal(31L, "erin", "USER", "FREE");
        UserAccount user = new UserAccount();
        user.setId(31L);
        user.setUsername("erin");
        user.setRole("USER");
        user.setPlan("PRO");

        when(userAccountRepository.findById(31L)).thenReturn(Optional.of(user));
        when(jwtUtil.createAccessToken(31L, "erin", "USER", "PRO")).thenReturn("token-pro");

        AuthResponse response = userService.refreshAccessToken(principal);

        assertEquals(31L, response.userId());
        assertEquals("token-pro", response.accessToken());
        assertEquals(3600L, response.expiresInSeconds());
    }

    @Test
    void me_shouldReturnUserProfile() {
        UserPrincipal principal = new UserPrincipal(22L, "dana", "USER", "FREE");
        UserAccount user = new UserAccount();
        user.setId(22L);
        user.setUsername("dana");
        user.setEmail("dana@example.com");

        when(userAccountRepository.findById(22L)).thenReturn(Optional.of(user));

        UserProfileResponse response = userService.me(principal);

        assertEquals(22L, response.userId());
        assertEquals("dana", response.username());
        assertEquals("dana@example.com", response.email());
        assertEquals("it", response.domainMode());
    }
}
