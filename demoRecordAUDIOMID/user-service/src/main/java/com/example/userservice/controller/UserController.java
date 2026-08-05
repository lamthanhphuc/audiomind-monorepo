package com.example.userservice.controller;

import com.example.userservice.client.MeetingClient;
import com.example.userservice.client.ProcessingClient;
import com.example.userservice.controller.dto.AuthResponse;
import com.example.userservice.controller.dto.LoginRequest;
import com.example.userservice.controller.dto.RegisterRequest;
import com.example.userservice.controller.dto.RegisterResponse;
import com.example.userservice.controller.dto.UserPreferencesRequest;
import com.example.userservice.controller.dto.UserProfileResponse;
import com.example.userservice.controller.dto.UserProfileUpdateRequest;
import com.example.userservice.security.UserPrincipal;
import com.example.userservice.service.UserService;
import jakarta.validation.Valid;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
public class UserController {

    private final UserService userService;
    private final ProcessingClient processingClient;
    private final MeetingClient meetingClient;

    @PostMapping("/register")
    public RegisterResponse register(@Valid @RequestBody RegisterRequest request) {
        return userService.register(request);
    }

    @PostMapping("/login")
    public AuthResponse login(@Valid @RequestBody LoginRequest request) {
        return userService.login(request);
    }

    @PostMapping("/logout")
    public ResponseEntity<Map<String, String>> logout(
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        userService.logout(authorization);
        return ResponseEntity.ok(Map.of("status", "logged_out"));
    }

    @PostMapping("/refresh-token")
    public AuthResponse refreshToken(Authentication authentication) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return userService.refreshAccessToken(principal);
    }

    @GetMapping("/me")
    public UserProfileResponse me(Authentication authentication) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return userService.me(principal);
    }

    @PatchMapping("/me/profile")
    public Map<String, Object> updateProfile(
            Authentication authentication,
            @Valid @RequestBody UserProfileUpdateRequest request
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return userService.updateProfile(principal, request);
    }

    @PatchMapping("/me/preferences")
    public Map<String, Object> updatePreferences(
            Authentication authentication,
            @RequestBody UserPreferencesRequest request
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return userService.updatePreferences(principal, request);
    }

    @GetMapping("/me/jobs")
    public Map<String, Object> myJobs(
            Authentication authentication,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization
    ) {
        UserPrincipal principal = (UserPrincipal) authentication.getPrincipal();
        return Map.of(
                "status", "ok",
                "processing", processingClient.getUserJobs(principal.userId(), authorization),
                "meeting", meetingClient.getUserMeetings(principal.userId(), authorization));
    }
}
