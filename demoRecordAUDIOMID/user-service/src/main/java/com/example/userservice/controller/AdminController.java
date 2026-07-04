package com.example.userservice.controller;

import com.example.userservice.billing.BillingService;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.security.UserPrincipal;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/admin")
@RequiredArgsConstructor
public class AdminController {

    private final BillingService billingService;
    private final UserAccountRepository userAccountRepository;

    @GetMapping("/users")
    public List<Map<String, Object>> listUsers(Authentication authentication) {
        requireAdmin(authentication);
        return userAccountRepository.findAll().stream()
                .limit(200)
                .map(u -> {
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("id", u.getId());
                    out.put("username", u.getUsername());
                    out.put("email", u.getEmail());
                    out.put("role", u.getRole());
                    out.put("plan", u.getPlan());
                    out.put("createdAt", u.getCreatedAt() == null ? null : u.getCreatedAt().toString());
                    return out;
                })
                .toList();
    }

    @PatchMapping("/users/{userId}/plan")
    public Map<String, Object> setPlan(
            @PathVariable Long userId,
            @Valid @RequestBody SetPlanRequest request,
            Authentication authentication
    ) {
        requireAdmin(authentication);
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
        user.setPlan(request.plan().trim().toUpperCase());
        userAccountRepository.save(user);
        return Map.of("ok", true, "userId", user.getId(), "plan", user.getPlan());
    }

    @PatchMapping("/users/{userId}/role")
    public Map<String, Object> setRole(
            @PathVariable Long userId,
            @Valid @RequestBody SetRoleRequest request,
            Authentication authentication
    ) {
        requireAdmin(authentication);
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
        user.setRole(request.role().trim().toUpperCase());
        userAccountRepository.save(user);
        return Map.of("ok", true, "userId", user.getId(), "role", user.getRole());
    }

    @PostMapping("/billing/manual-paid")
    public Map<String, Object> manualMarkPaid(
            @Valid @RequestBody ManualPaidRequest request,
            Authentication authentication
    ) {
        requireAdmin(authentication);
        billingService.adminMarkPaid(request.orderCode(), request.note());
        return Map.of("ok", true);
    }

    private static UserPrincipal requireAdmin(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        if (!"ADMIN".equalsIgnoreCase(principal.role())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Forbidden");
        }
        return principal;
    }

    public record ManualPaidRequest(
            @Min(1) long orderCode,
            String note
    ) {
    }

    public record SetPlanRequest(@NotBlank String plan) {
    }

    public record SetRoleRequest(@NotBlank String role) {
    }
}

