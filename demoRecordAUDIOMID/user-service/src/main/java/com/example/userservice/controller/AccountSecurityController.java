package com.example.userservice.controller;

import com.example.userservice.security.UserPrincipal;
import com.example.userservice.service.UserService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/users/me/security")
@RequiredArgsConstructor
public class AccountSecurityController {

    private final UserService userService;

    @GetMapping
    public Map<String, Object> overview(
            Authentication authentication,
            @RequestHeader(name = HttpHeaders.AUTHORIZATION, required = false) String authorization
    ) {
        return userService.securityOverview(requirePrincipal(authentication), authorization);
    }

    @PatchMapping("/password")
    public Map<String, Object> changePassword(
            Authentication authentication,
            @Valid @RequestBody ChangePasswordRequest request
    ) {
        return userService.changePassword(
                requirePrincipal(authentication),
                request.currentPassword(),
                request.newPassword()
        );
    }

    @PostMapping("/logout-all")
    public Map<String, Object> logoutAll(Authentication authentication) {
        return userService.logoutAllDevices(requirePrincipal(authentication));
    }

    private static UserPrincipal requirePrincipal(Authentication authentication) {
        return (UserPrincipal) authentication.getPrincipal();
    }

    public record ChangePasswordRequest(
            @NotBlank String currentPassword,
            @NotBlank @Size(min = 8, max = 200) String newPassword
    ) {
    }
}
