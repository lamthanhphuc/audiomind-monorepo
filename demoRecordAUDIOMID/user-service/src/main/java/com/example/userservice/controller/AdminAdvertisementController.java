package com.example.userservice.controller;

import com.example.userservice.advertising.AdvertisementService;
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
@RequestMapping("/api/admin/advertisements")
@RequiredArgsConstructor
public class AdminAdvertisementController {

    private final AdvertisementService advertisementService;
    private final AuditEventService auditEventService;

    @GetMapping
    public Map<String, Object> list(Authentication authentication) {
        requireAdmin(authentication);
        return Map.of("items", advertisementService.listAll().stream()
                .map(advertisementService::toView)
                .toList());
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable Long id, Authentication authentication) {
        requireAdmin(authentication);
        return advertisementService.toView(advertisementService.requireById(id));
    }

    @PostMapping
    public Map<String, Object> create(
            @RequestBody AdvertisementService.AdvertisementRequest request,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        var ad = advertisementService.create(request);
        auditEventService.record(admin.userId(), "ADVERTISEMENT_CREATED", "ADVERTISEMENT",
                String.valueOf(ad.getId()), "Admin created advertisement", Map.of("title", ad.getTitle()));
        return advertisementService.toView(ad);
    }

    @PutMapping("/{id}")
    public Map<String, Object> update(
            @PathVariable Long id,
            @RequestBody AdvertisementService.AdvertisementRequest request,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        var ad = advertisementService.update(id, request);
        auditEventService.record(admin.userId(), "ADVERTISEMENT_UPDATED", "ADVERTISEMENT",
                String.valueOf(ad.getId()), "Admin updated advertisement", Map.of("title", ad.getTitle()));
        return advertisementService.toView(ad);
    }

    @PatchMapping("/{id}/status")
    public Map<String, Object> status(
            @PathVariable Long id,
            @RequestBody StatusRequest request,
            Authentication authentication
    ) {
        UserPrincipal admin = requireAdmin(authentication);
        var ad = advertisementService.setStatus(id, request.status());
        String eventType = "ACTIVE".equalsIgnoreCase(ad.getStatus())
                ? "ADVERTISEMENT_ACTIVATED"
                : "PAUSED".equalsIgnoreCase(ad.getStatus())
                    ? "ADVERTISEMENT_PAUSED"
                    : "ADVERTISEMENT_UPDATED";
        auditEventService.record(admin.userId(), eventType, "ADVERTISEMENT",
                String.valueOf(ad.getId()), "Admin changed advertisement status", Map.of("status", ad.getStatus()));
        return advertisementService.toView(ad);
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable Long id, Authentication authentication) {
        UserPrincipal admin = requireAdmin(authentication);
        advertisementService.delete(id);
        auditEventService.record(admin.userId(), "ADVERTISEMENT_DELETED", "ADVERTISEMENT",
                String.valueOf(id), "Admin deleted advertisement", Map.of());
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

    public record StatusRequest(String status) {
    }
}
