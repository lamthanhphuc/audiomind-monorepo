package com.example.meetingservice.controller;

import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingShareService;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/meetings/{meetingId}/shares")
public class MeetingShareController {

    private final MeetingShareService meetingShareService;

    public MeetingShareController(MeetingShareService meetingShareService) {
        this.meetingShareService = meetingShareService;
    }

    @GetMapping
    public List<Map<String, Object>> listShares(
            @PathVariable Long meetingId,
            Authentication authentication) {
        return meetingShareService.listShares(meetingId, requirePrincipal(authentication).userId());
    }

    @PostMapping
    public Map<String, Object> inviteShare(
            @PathVariable Long meetingId,
            @RequestBody InviteShareRequest request,
            Authentication authentication) {
        return meetingShareService.inviteByEmail(
                meetingId,
                requirePrincipal(authentication).userId(),
                request == null ? null : request.email(),
                request == null ? null : request.role()
        );
    }

    @DeleteMapping("/pending")
    public Map<String, Object> revokePendingInvite(
            @PathVariable Long meetingId,
            @RequestParam String email,
            Authentication authentication) {
        meetingShareService.revokePendingInvite(meetingId, requirePrincipal(authentication).userId(), email);
        return Map.of("meetingId", meetingId, "email", email, "revoked", true);
    }

    @DeleteMapping("/{sharedWithUserId}")
    public Map<String, Object> revokeShare(
            @PathVariable Long meetingId,
            @PathVariable Long sharedWithUserId,
            Authentication authentication) {
        meetingShareService.revokeShare(meetingId, requirePrincipal(authentication).userId(), sharedWithUserId);
        return Map.of("meetingId", meetingId, "sharedWithUserId", sharedWithUserId, "revoked", true);
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }

    public record InviteShareRequest(String email, String role) {
    }
}
