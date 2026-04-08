package com.example.userservice.service;

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
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class UserService {

    private static final Logger log = LoggerFactory.getLogger(UserService.class);

    private final UserAccountRepository userAccountRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtUtil jwtUtil;
    private final TokenBlacklistStore tokenBlacklistStore;

    @Value("${app.security.jwt.access-expiration-seconds}")
    private long accessExpirationSeconds;

    @Transactional
    public RegisterResponse register(RegisterRequest request) {
        if (userAccountRepository.existsByUsername(request.username())) {
            throw new IllegalArgumentException("Username already exists");
        }
        if (userAccountRepository.existsByEmail(request.email())) {
            throw new IllegalArgumentException("Email already exists");
        }

        UserAccount user = new UserAccount();
        user.setUsername(request.username());
        user.setEmail(request.email());
        user.setPasswordHash(passwordEncoder.encode(request.password()));

        UserAccount saved = userAccountRepository.save(user);
        log.info("user registered");

        return new RegisterResponse(saved.getId());
    }

    @Transactional(readOnly = true)
    public AuthResponse login(LoginRequest request) {
        UserAccount user = userAccountRepository.findByUsername(request.username())
                .orElseThrow(() -> new BadCredentialsException("Invalid username or password"));

        if (!passwordEncoder.matches(request.password(), user.getPasswordHash())) {
            throw new BadCredentialsException("Invalid username or password");
        }

        String accessToken = jwtUtil.createAccessToken(user.getId(), user.getUsername());
        log.info("user login accepted");

        return new AuthResponse(user.getId(), accessToken, accessExpirationSeconds);
    }

    public void logout(String bearerToken) {
        String token = extractBearerToken(bearerToken);
        Claims claims = jwtUtil.parseClaims(token);
        long ttlSeconds = jwtUtil.remainingTtlSeconds(token);
        tokenBlacklistStore.blacklist(token, ttlSeconds);
        log.info("user logout accepted for userId={}", claims.getSubject());
    }

    @Transactional(readOnly = true)
    public UserProfileResponse me(UserPrincipal principal) {
        UserAccount user = userAccountRepository.findById(principal.userId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));

        return new UserProfileResponse(user.getId(), user.getUsername(), user.getEmail());
    }

    private String extractBearerToken(String bearerToken) {
        if (bearerToken == null || !bearerToken.startsWith("Bearer ")) {
            throw new BadCredentialsException("Missing bearer token");
        }
        return bearerToken.substring(7);
    }
}
