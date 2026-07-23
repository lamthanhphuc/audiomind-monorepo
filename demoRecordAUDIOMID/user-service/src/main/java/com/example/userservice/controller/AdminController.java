package com.example.userservice.controller;

import com.example.userservice.billing.BillingService;
import com.example.userservice.entity.BillingInvoice;
import com.example.userservice.entity.UserApiKey;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.BillingInvoiceRepository;
import com.example.userservice.repository.UserApiKeyRepository;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.security.UserPrincipal;
import com.example.userservice.service.AuditEventService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/admin")
@RequiredArgsConstructor
public class AdminController {

    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private final BillingService billingService;
    private final UserAccountRepository userAccountRepository;
    private final UserApiKeyRepository userApiKeyRepository;
    private final BillingInvoiceRepository billingInvoiceRepository;
    private final AuditEventService auditEventService;

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
        UserPrincipal admin = requireAdmin(authentication);
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
        String nextPlan = normalizePlan(request.plan());
        String previousPlan = user.getPlan();
        user.setPlan(nextPlan);
        userAccountRepository.save(user);
        auditEventService.record(
                admin.userId(),
                "ADMIN_USER_PLAN_CHANGED",
                "USER",
                String.valueOf(user.getId()),
                "Admin changed user plan",
                Map.of("previousPlan", previousPlan, "nextPlan", nextPlan)
        );
        return Map.of("ok", true, "userId", user.getId(), "plan", user.getPlan());
    }

    @PatchMapping("/users/{userId}/role")
    public Map<String, Object> setRole(
            @PathVariable Long userId,
            @Valid @RequestBody SetRoleRequest request,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
        String nextRole = normalizeRole(request.role());
        String previousRole = user.getRole();
        user.setRole(nextRole);
        userAccountRepository.save(user);
        auditEventService.record(
                admin.userId(),
                "ADMIN_USER_ROLE_CHANGED",
                "USER",
                String.valueOf(user.getId()),
                "Admin changed user role",
                Map.of("previousRole", previousRole, "nextRole", nextRole)
        );
        return Map.of("ok", true, "userId", user.getId(), "role", user.getRole());
    }

    @PostMapping("/billing/manual-paid")
    public Map<String, Object> manualMarkPaid(
            @Valid @RequestBody ManualPaidRequest request,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        billingService.adminMarkPaid(request.orderCode(), request.note());
        auditEventService.record(
                admin.userId(),
                "ADMIN_BILLING_MANUAL_PAID",
                "BILLING_ORDER",
                String.valueOf(request.orderCode()),
                "Admin manually marked billing order paid",
                Map.of("note", request.note() == null ? "" : request.note())
        );
        return Map.of("ok", true);
    }

    @GetMapping("/billing/transactions")
    public Map<String, Object> listTransactions(
            Authentication authentication,
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) Integer limit
    ) {
        requireAdmin(authentication);
        int safeLimit = Math.max(1, Math.min(limit == null ? 100 : limit, 200));
        PageRequest page = PageRequest.of(0, safeLimit);
        String normalizedStatus = status == null || status.isBlank() ? null : status.trim().toUpperCase();
        List<BillingInvoice> invoices;
        if (userId != null && normalizedStatus != null) {
            invoices = billingInvoiceRepository.findByUserIdAndStatusIgnoreCaseOrderByCreatedAtDesc(userId, normalizedStatus, page);
        } else if (userId != null) {
            invoices = billingInvoiceRepository.findByUserIdOrderByCreatedAtDesc(userId, page);
        } else if (normalizedStatus != null) {
            invoices = billingInvoiceRepository.findByStatusIgnoreCaseOrderByCreatedAtDesc(normalizedStatus, page);
        } else {
            invoices = billingInvoiceRepository.findByOrderByCreatedAtDesc(page);
        }
        return Map.of("items", invoices.stream().map(this::invoiceView).toList());
    }

    @GetMapping("/users/{userId}/api-keys")
    public Map<String, Object> listUserApiKeys(
            @PathVariable Long userId,
            Authentication authentication
    ) {
        requireAdmin(authentication);
        ensureUserExists(userId);
        return Map.of("items", userApiKeyRepository.findTop100ByUserIdOrderByCreatedAtDesc(userId)
                .stream()
                .map(this::apiKeyView)
                .toList());
    }

    @PostMapping("/users/{userId}/api-keys")
    public Map<String, Object> createUserApiKey(
            @PathVariable Long userId,
            @Valid @RequestBody CreateApiKeyRequest request,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        ensureUserExists(userId);
        String plaintext = generateApiKey();
        UserApiKey key = new UserApiKey();
        key.setUserId(userId);
        key.setName(request.name().trim());
        key.setScopes(normalizeScopes(request.scopes()));
        key.setKeyHash(sha256Hex(plaintext));
        key.setKeyPrefix(plaintext.substring(0, Math.min(8, plaintext.length())));
        key.setKeySuffix(plaintext.substring(Math.max(0, plaintext.length() - 6)));
        key.setCreatedBy(admin.userId());
        UserApiKey saved = userApiKeyRepository.save(key);
        auditEventService.record(
                admin.userId(),
                "ADMIN_USER_API_KEY_CREATED",
                "USER_API_KEY",
                String.valueOf(saved.getId()),
                "Admin created user API key",
                Map.of("userId", userId, "name", saved.getName(), "scopes", saved.getScopes())
        );
        Map<String, Object> view = new LinkedHashMap<>(apiKeyView(saved));
        view.put("apiKey", plaintext);
        return view;
    }

    @DeleteMapping("/users/{userId}/api-keys/{keyId}")
    public Map<String, Object> revokeUserApiKey(
            @PathVariable Long userId,
            @PathVariable Long keyId,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        UserApiKey key = userApiKeyRepository.findByIdAndUserId(keyId, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "API key not found"));
        if (key.getRevokedAt() == null) {
            key.setRevokedAt(Instant.now());
            userApiKeyRepository.save(key);
            auditEventService.record(
                    admin.userId(),
                    "ADMIN_USER_API_KEY_REVOKED",
                    "USER_API_KEY",
                    String.valueOf(key.getId()),
                    "Admin revoked user API key",
                    Map.of("userId", userId, "name", key.getName())
            );
        }
        return apiKeyView(key);
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

    public record CreateApiKeyRequest(
            @NotBlank @Size(max = 120) String name,
            @Size(max = 255) String scopes
    ) {
    }

    private static String normalizePlan(String plan) {
        String normalized = plan == null ? "" : plan.trim().toUpperCase();
        if (!"FREE".equals(normalized) && !"PRO".equals(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid plan");
        }
        return normalized;
    }

    private static String normalizeRole(String role) {
        String normalized = role == null ? "" : role.trim().toUpperCase();
        if (!"USER".equals(normalized) && !"ADMIN".equals(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid role");
        }
        return normalized;
    }

    private void ensureUserExists(Long userId) {
        if (userId == null || userAccountRepository.findById(userId).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found");
        }
    }

    private Map<String, Object> apiKeyView(UserApiKey key) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", key.getId());
        out.put("userId", key.getUserId());
        out.put("name", key.getName());
        out.put("prefix", key.getKeyPrefix());
        out.put("suffix", key.getKeySuffix());
        out.put("scopes", key.getScopes());
        out.put("createdAt", key.getCreatedAt() == null ? null : key.getCreatedAt().toString());
        out.put("revokedAt", key.getRevokedAt() == null ? null : key.getRevokedAt().toString());
        out.put("lastUsedAt", key.getLastUsedAt() == null ? null : key.getLastUsedAt().toString());
        return out;
    }

    private Map<String, Object> invoiceView(BillingInvoice invoice) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", invoice.getId());
        out.put("userId", invoice.getUserId());
        out.put("provider", invoice.getProvider());
        out.put("orderCode", invoice.getOrderCode());
        out.put("paymentLinkId", invoice.getPaymentLinkId());
        out.put("amountVnd", invoice.getAmountVnd());
        out.put("currency", invoice.getCurrency());
        out.put("status", invoice.getStatus());
        out.put("description", invoice.getDescription());
        out.put("createdAt", invoice.getCreatedAt() == null ? null : invoice.getCreatedAt().toString());
        out.put("paidAt", invoice.getPaidAt() == null ? null : invoice.getPaidAt().toString());
        out.put("cancelledAt", invoice.getCancelledAt() == null ? null : invoice.getCancelledAt().toString());
        out.put("expiredAt", invoice.getExpiredAt() == null ? null : invoice.getExpiredAt().toString());
        out.put("manualNote", invoice.getManualNote());
        return out;
    }

    private static String normalizeScopes(String scopes) {
        String normalized = scopes == null || scopes.isBlank() ? "read" : scopes.trim();
        String result = java.util.Arrays.stream(normalized.split(","))
                .map(scope -> scope.trim().toLowerCase(Locale.ROOT))
                .filter(scope -> !scope.isBlank())
                .peek(scope -> {
                    if (!"read".equals(scope) && !"write".equals(scope) && !"admin".equals(scope)) {
                        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid API key scope");
                    }
                })
                .distinct()
                .collect(Collectors.joining(","));
        return result.isBlank() ? "read" : result;
    }

    private static String generateApiKey() {
        byte[] random = new byte[32];
        SECURE_RANDOM.nextBytes(random);
        return "am_" + Base64.getUrlEncoder().withoutPadding().encodeToString(random);
    }

    private static String sha256Hex(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (Exception ex) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Could not hash API key");
        }
    }
}

