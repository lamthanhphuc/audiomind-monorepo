package com.example.userservice.controller;

import com.example.userservice.plan.SubscriptionPlanService;
import com.example.userservice.security.UserPrincipal;
import com.example.userservice.service.AuditEventService;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/admin/plans")
@RequiredArgsConstructor
public class AdminPlanController {

    private final SubscriptionPlanService subscriptionPlanService;
    private final AuditEventService auditEventService;

    @GetMapping
    public Map<String, Object> list(Authentication authentication) {
        requireAdmin(authentication);
        return Map.of("items", subscriptionPlanService.listAll().stream()
                .map(subscriptionPlanService::toView)
                .toList());
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable Long id, Authentication authentication) {
        requireAdmin(authentication);
        return subscriptionPlanService.toView(subscriptionPlanService.requireById(id));
    }

    @PostMapping
    public Map<String, Object> create(
            @RequestBody SubscriptionPlanService.PlanRequest request,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        var plan = subscriptionPlanService.create(request);
        auditEventService.record(admin.userId(), "PLAN_CREATED", "SUBSCRIPTION_PLAN",
                String.valueOf(plan.getId()), "Admin created subscription plan", Map.of("code", plan.getCode()));
        return subscriptionPlanService.toView(plan);
    }

    @PutMapping("/{id}")
    public Map<String, Object> update(
            @PathVariable Long id,
            @RequestBody SubscriptionPlanService.PlanRequest request,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        var plan = subscriptionPlanService.update(id, request);
        auditEventService.record(admin.userId(), "PLAN_UPDATED", "SUBSCRIPTION_PLAN",
                String.valueOf(plan.getId()), "Admin updated subscription plan", Map.of("code", plan.getCode()));
        return subscriptionPlanService.toView(plan);
    }

    @PatchMapping("/{id}/status")
    public Map<String, Object> status(
            @PathVariable Long id,
            @RequestBody StatusRequest request,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        var plan = subscriptionPlanService.setStatus(id, Boolean.TRUE.equals(request.active()));
        auditEventService.record(
                admin.userId(),
                plan.isActive() ? "PLAN_ACTIVATED" : "PLAN_DEACTIVATED",
                "SUBSCRIPTION_PLAN",
                String.valueOf(plan.getId()),
                plan.isActive() ? "Admin activated subscription plan" : "Admin deactivated subscription plan",
                Map.of("code", plan.getCode())
        );
        return subscriptionPlanService.toView(plan);
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable Long id, Authentication authentication) {
        UserPrincipal admin = requireAdmin(authentication);
        subscriptionPlanService.delete(id);
        auditEventService.record(admin.userId(), "PLAN_DELETED", "SUBSCRIPTION_PLAN",
                String.valueOf(id), "Admin deleted subscription plan", Map.of());
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

    public record StatusRequest(Boolean active) {
    }
}
