package com.example.userservice.controller;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.UserAccountRepository;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/internal/users")
@RequiredArgsConstructor
public class InternalUserController {

    private final UserAccountRepository userAccountRepository;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    @GetMapping("/lookup")
    public Map<String, Object> lookupByEmail(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,
            @RequestParam String email
    ) {
        requireInternalToken(token);
        if (email == null || email.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Email is required");
        }
        UserAccount user = userAccountRepository.findByEmailIgnoreCase(email.trim())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
        return Map.of(
                "userId", user.getId(),
                "email", user.getEmail(),
                "username", user.getUsername()
        );
    }

    @GetMapping("/by-id")
    public Map<String, Object> lookupById(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,
            @RequestParam Long userId
    ) {
        requireInternalToken(token);
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "User id is required");
        }
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
        return Map.of(
                "userId", user.getId(),
                "email", user.getEmail(),
                "username", user.getUsername()
        );
    }

    private void requireInternalToken(String token) {
        if (internalServiceToken == null || internalServiceToken.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Internal token not configured");
        }
        if (token == null || token.isBlank() || !internalServiceToken.equals(token)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
    }
}
