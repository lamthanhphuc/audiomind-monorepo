package com.example.userservice.controller;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.security.UserPrincipal;
import com.example.userservice.service.WorkspaceService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequiredArgsConstructor
public class WorkspaceController {

    private final UserAccountRepository userAccountRepository;
    private final WorkspaceService workspaceService;

    @GetMapping({"/api/workspace/me", "/api/workspaces/me"})
    public Map<String, Object> myWorkspace(Authentication authentication) {
        UserAccount user = currentUser(authentication);
        return workspaceService.getMyWorkspace(user);
    }

    @PatchMapping("/api/workspaces/{workspaceId}")
    public Map<String, Object> renameWorkspace(
            @PathVariable Long workspaceId,
            @Valid @RequestBody RenameWorkspaceRequest request,
            Authentication authentication
    ) {
        UserPrincipal principal = currentPrincipal(authentication);
        return workspaceService.renameWorkspace(principal.userId(), workspaceId, request.name());
    }

    @PostMapping("/api/workspaces/{workspaceId}/members")
    public Map<String, Object> inviteOrAddMember(
            @PathVariable Long workspaceId,
            @Valid @RequestBody InviteMemberRequest request,
            Authentication authentication
    ) {
        UserPrincipal principal = currentPrincipal(authentication);
        return workspaceService.inviteOrAddMember(principal.userId(), workspaceId, request.email(), request.role());
    }

    @PatchMapping("/api/workspaces/{workspaceId}/members/{memberUserId}")
    public Map<String, Object> updateMemberRole(
            @PathVariable Long workspaceId,
            @PathVariable Long memberUserId,
            @Valid @RequestBody UpdateMemberRoleRequest request,
            Authentication authentication
    ) {
        UserPrincipal principal = currentPrincipal(authentication);
        return workspaceService.updateMemberRole(principal.userId(), workspaceId, memberUserId, request.role());
    }

    @DeleteMapping("/api/workspaces/{workspaceId}/members/{memberUserId}")
    public Map<String, Object> removeMember(
            @PathVariable Long workspaceId,
            @PathVariable Long memberUserId,
            Authentication authentication
    ) {
        UserPrincipal principal = currentPrincipal(authentication);
        workspaceService.removeMember(principal.userId(), workspaceId, memberUserId);
        return Map.of("ok", true);
    }

    @PostMapping("/api/workspaces/{workspaceId}/invites/{inviteId}/accept")
    public Map<String, Object> acceptInvite(
            @PathVariable Long workspaceId,
            @PathVariable Long inviteId,
            Authentication authentication
    ) {
        UserPrincipal principal = currentPrincipal(authentication);
        return workspaceService.acceptInvite(principal.userId(), workspaceId, inviteId);
    }

    @PostMapping("/api/workspaces/{workspaceId}/invites/{inviteId}/reject")
    public Map<String, Object> rejectInvite(
            @PathVariable Long workspaceId,
            @PathVariable Long inviteId,
            Authentication authentication
    ) {
        UserPrincipal principal = currentPrincipal(authentication);
        return workspaceService.rejectInvite(principal.userId(), workspaceId, inviteId);
    }

    @PostMapping("/api/workspaces/{workspaceId}/transfer-ownership")
    public Map<String, Object> transferOwnership(
            @PathVariable Long workspaceId,
            @Valid @RequestBody TransferOwnershipRequest request,
            Authentication authentication
    ) {
        UserPrincipal principal = currentPrincipal(authentication);
        return workspaceService.transferOwnership(principal.userId(), workspaceId, request.nextOwnerUserId());
    }

    private UserAccount currentUser(Authentication authentication) {
        UserPrincipal principal = currentPrincipal(authentication);
        return userAccountRepository.findById(principal.userId())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not found"));
    }

    private UserPrincipal currentPrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }

    public record RenameWorkspaceRequest(
            @NotBlank @Size(max = 160) String name
    ) {
    }

    public record InviteMemberRequest(
            @NotBlank @Email @Size(max = 255) String email,
            @NotBlank String role
    ) {
    }

    public record UpdateMemberRoleRequest(
            @NotBlank String role
    ) {
    }

    public record TransferOwnershipRequest(
            @Min(1) Long nextOwnerUserId
    ) {
    }
}
