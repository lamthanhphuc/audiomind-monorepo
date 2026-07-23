package com.example.userservice.service;

import com.example.userservice.client.MeetingClient;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.Workspace;
import com.example.userservice.entity.WorkspaceInvite;
import com.example.userservice.entity.WorkspaceMember;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.WorkspaceInviteRepository;
import com.example.userservice.repository.WorkspaceMemberRepository;
import com.example.userservice.repository.WorkspaceRepository;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class WorkspaceService {

    private final WorkspaceRepository workspaceRepository;
    private final WorkspaceMemberRepository memberRepository;
    private final WorkspaceInviteRepository inviteRepository;
    private final UserAccountRepository userAccountRepository;
    private final MeetingClient meetingClient;
    private final AuditEventService auditEventService;

    @Transactional
    public Map<String, Object> getMyWorkspace(UserAccount user) {
        Workspace workspace = ensureDefaultWorkspace(user);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("workspace", workspaceView(workspace));
        out.put("members", memberRepository.findByWorkspaceIdOrderByCreatedAtAsc(workspace.getId())
                .stream()
                .map(this::memberView)
                .toList());
        out.put("pendingInvites", inviteRepository.findByWorkspaceIdAndStatusOrderByCreatedAtDesc(workspace.getId(), "PENDING")
                .stream()
                .map(this::inviteView)
                .toList());
        out.put("myPendingInvites", inviteRepository.findByEmailIgnoreCaseAndStatusOrderByCreatedAtDesc(user.getEmail(), "PENDING")
                .stream()
                .map(this::inviteView)
                .toList());
        Map<String, Object> meetingSummary = meetingClient.getWorkspaceSummary(user.getId(), user.getEmail());
        out.put("ownedMeetingCount", meetingSummary.getOrDefault("ownedMeetingCount", 0));
        out.put("sharedWithMeCount", meetingSummary.getOrDefault("sharedWithMeCount", 0));
        out.put("sharedMeetings", meetingSummary.getOrDefault("sharedMeetings", List.of()));
        out.put("meetingShareMembers", meetingSummary.getOrDefault("members", List.of()));
        out.put("meetingShareInvites", meetingSummary.getOrDefault("pendingInvites", List.of()));
        if (meetingSummary.get("error") != null) {
            out.put("meetingShareError", meetingSummary.get("error"));
        }
        return out;
    }

    @Transactional
    public Map<String, Object> renameWorkspace(Long actorUserId, Long workspaceId, String name) {
        Workspace workspace = requireManageAccess(actorUserId, workspaceId);
        String trimmed = name == null ? "" : name.trim();
        if (trimmed.isBlank() || trimmed.length() > 160) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid workspace name");
        }
        workspace.setName(trimmed);
        Workspace saved = workspaceRepository.save(workspace);
        auditEventService.record(actorUserId, "WORKSPACE_RENAMED", "WORKSPACE", String.valueOf(workspaceId),
                "Workspace renamed", Map.of("name", trimmed));
        return workspaceView(saved);
    }

    @Transactional
    public Map<String, Object> inviteOrAddMember(Long actorUserId, Long workspaceId, String email, String role) {
        Workspace workspace = requireManageAccess(actorUserId, workspaceId);
        String normalizedEmail = normalizeEmail(email);
        String normalizedRole = normalizeMemberRole(role);
        UserAccount existingUser = userAccountRepository.findByEmailIgnoreCase(normalizedEmail).orElse(null);
        if (existingUser != null) {
            WorkspaceMember member = memberRepository.findByWorkspaceIdAndUserId(workspace.getId(), existingUser.getId())
                    .orElseGet(() -> {
                        WorkspaceMember next = new WorkspaceMember();
                        next.setWorkspaceId(workspace.getId());
                        next.setUserId(existingUser.getId());
                        return next;
                    });
            if ("OWNER".equalsIgnoreCase(member.getRole())) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot change owner via invite");
            }
            member.setRole(normalizedRole);
            WorkspaceMember saved = memberRepository.save(member);
            auditEventService.record(actorUserId, "WORKSPACE_MEMBER_ADDED", "WORKSPACE", String.valueOf(workspaceId),
                    "Workspace member added", Map.of("memberUserId", existingUser.getId(), "role", normalizedRole));
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("member", memberView(saved));
            out.put("invite", null);
            return out;
        }

        WorkspaceInvite invite = inviteRepository
                .findByWorkspaceIdAndEmailIgnoreCaseAndStatus(workspace.getId(), normalizedEmail, "PENDING")
                .orElseGet(() -> {
                    WorkspaceInvite next = new WorkspaceInvite();
                    next.setWorkspaceId(workspace.getId());
                    next.setEmail(normalizedEmail);
                    next.setInvitedBy(actorUserId);
                    return next;
                });
        invite.setRole(normalizedRole);
        WorkspaceInvite saved = inviteRepository.save(invite);
        auditEventService.record(actorUserId, "WORKSPACE_INVITE_CREATED", "WORKSPACE", String.valueOf(workspaceId),
                "Workspace invite created", Map.of("email", normalizedEmail, "role", normalizedRole));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("member", null);
        out.put("invite", inviteView(saved));
        return out;
    }

    @Transactional
    public Map<String, Object> updateMemberRole(Long actorUserId, Long workspaceId, Long memberUserId, String role) {
        requireManageAccess(actorUserId, workspaceId);
        WorkspaceMember member = memberRepository.findByWorkspaceIdAndUserId(workspaceId, memberUserId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Member not found"));
        if ("OWNER".equalsIgnoreCase(member.getRole())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Use ownership transfer for owner");
        }
        member.setRole(normalizeMemberRole(role));
        WorkspaceMember saved = memberRepository.save(member);
        auditEventService.record(actorUserId, "WORKSPACE_MEMBER_ROLE_CHANGED", "WORKSPACE", String.valueOf(workspaceId),
                "Workspace member role changed", Map.of("memberUserId", memberUserId, "role", saved.getRole()));
        return memberView(saved);
    }

    @Transactional
    public Map<String, Object> acceptInvite(Long actorUserId, Long workspaceId, Long inviteId) {
        UserAccount user = userAccountRepository.findById(actorUserId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not found"));
        WorkspaceInvite invite = inviteRepository.findByIdAndWorkspaceId(inviteId, workspaceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Invite not found"));
        if (!"PENDING".equalsIgnoreCase(invite.getStatus())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invite is not pending");
        }
        if (!invite.getEmail().equalsIgnoreCase(user.getEmail())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Invite belongs to another email");
        }
        WorkspaceMember member = memberRepository.findByWorkspaceIdAndUserId(workspaceId, actorUserId)
                .orElseGet(() -> {
                    WorkspaceMember next = new WorkspaceMember();
                    next.setWorkspaceId(workspaceId);
                    next.setUserId(actorUserId);
                    return next;
                });
        member.setRole(normalizeMemberRole(invite.getRole()));
        WorkspaceMember savedMember = memberRepository.save(member);
        invite.setStatus("ACCEPTED");
        inviteRepository.save(invite);
        auditEventService.record(actorUserId, "WORKSPACE_INVITE_ACCEPTED", "WORKSPACE", String.valueOf(workspaceId),
                "Workspace invite accepted", Map.of("inviteId", inviteId));
        return memberView(savedMember);
    }

    @Transactional
    public Map<String, Object> rejectInvite(Long actorUserId, Long workspaceId, Long inviteId) {
        UserAccount user = userAccountRepository.findById(actorUserId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User not found"));
        WorkspaceInvite invite = inviteRepository.findByIdAndWorkspaceId(inviteId, workspaceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Invite not found"));
        boolean canManage = memberRepository.findByWorkspaceIdAndUserId(workspaceId, actorUserId)
                .map(member -> "OWNER".equalsIgnoreCase(member.getRole()) || "ADMIN".equalsIgnoreCase(member.getRole()))
                .orElse(false);
        if (!canManage && !invite.getEmail().equalsIgnoreCase(user.getEmail())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Invite belongs to another email");
        }
        if (!"PENDING".equalsIgnoreCase(invite.getStatus())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invite is not pending");
        }
        invite.setStatus("REJECTED");
        WorkspaceInvite saved = inviteRepository.save(invite);
        auditEventService.record(actorUserId, "WORKSPACE_INVITE_REJECTED", "WORKSPACE", String.valueOf(workspaceId),
                "Workspace invite rejected", Map.of("inviteId", inviteId));
        return inviteView(saved);
    }

    @Transactional
    public void removeMember(Long actorUserId, Long workspaceId, Long memberUserId) {
        Workspace workspace = requireManageAccess(actorUserId, workspaceId);
        if (workspace.getOwnerUserId().equals(memberUserId)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot remove workspace owner");
        }
        memberRepository.deleteByWorkspaceIdAndUserId(workspaceId, memberUserId);
        auditEventService.record(actorUserId, "WORKSPACE_MEMBER_REMOVED", "WORKSPACE", String.valueOf(workspaceId),
                "Workspace member removed", Map.of("memberUserId", memberUserId));
    }

    @Transactional(readOnly = true)
    public Map<String, Object> listWorkspaceMembersForUser(Long userId) {
        List<WorkspaceMember> memberships = memberRepository.findByUserIdOrderByCreatedAtAsc(userId);
        List<Long> workspaceIds = memberships.stream().map(WorkspaceMember::getWorkspaceId).distinct().toList();
        List<Map<String, Object>> members = workspaceIds.stream()
                .flatMap(workspaceId -> memberRepository.findByWorkspaceIdOrderByCreatedAtAsc(workspaceId).stream())
                .map(this::memberView)
                .toList();
        return Map.of("items", members);
    }

    @Transactional
    public Map<String, Object> transferOwnership(Long actorUserId, Long workspaceId, Long nextOwnerUserId) {
        Workspace workspace = workspaceRepository.findById(workspaceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Workspace not found"));
        if (!workspace.getOwnerUserId().equals(actorUserId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Only owner can transfer workspace");
        }
        WorkspaceMember nextOwner = memberRepository.findByWorkspaceIdAndUserId(workspaceId, nextOwnerUserId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "Next owner must be a workspace member"));
        WorkspaceMember previousOwner = memberRepository.findByWorkspaceIdAndUserId(workspaceId, actorUserId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "Current owner member is missing"));
        workspace.setOwnerUserId(nextOwnerUserId);
        previousOwner.setRole("ADMIN");
        nextOwner.setRole("OWNER");
        workspaceRepository.save(workspace);
        memberRepository.save(previousOwner);
        memberRepository.save(nextOwner);
        auditEventService.record(actorUserId, "WORKSPACE_OWNERSHIP_TRANSFERRED", "WORKSPACE", String.valueOf(workspaceId),
                "Workspace ownership transferred", Map.of("nextOwnerUserId", nextOwnerUserId));
        return workspaceView(workspace);
    }

    private Workspace ensureDefaultWorkspace(UserAccount user) {
        List<WorkspaceMember> existingMemberships = memberRepository.findByUserIdOrderByCreatedAtAsc(user.getId());
        if (!existingMemberships.isEmpty()) {
            Long workspaceId = existingMemberships.get(0).getWorkspaceId();
            return workspaceRepository.findById(workspaceId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Workspace not found"));
        }
        Workspace workspace = new Workspace();
        workspace.setOwnerUserId(user.getId());
        workspace.setName((user.getUsername() == null || user.getUsername().isBlank() ? "Audiomind" : user.getUsername()) + " workspace");
        Workspace saved = workspaceRepository.save(workspace);
        WorkspaceMember owner = new WorkspaceMember();
        owner.setWorkspaceId(saved.getId());
        owner.setUserId(user.getId());
        owner.setRole("OWNER");
        memberRepository.save(owner);
        return saved;
    }

    private Workspace requireManageAccess(Long actorUserId, Long workspaceId) {
        Workspace workspace = workspaceRepository.findById(workspaceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Workspace not found"));
        WorkspaceMember member = memberRepository.findByWorkspaceIdAndUserId(workspaceId, actorUserId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.FORBIDDEN, "Not a workspace member"));
        if (!"OWNER".equalsIgnoreCase(member.getRole()) && !"ADMIN".equalsIgnoreCase(member.getRole())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Workspace admin required");
        }
        return workspace;
    }

    private static String normalizeEmail(String email) {
        String normalized = email == null ? "" : email.trim().toLowerCase(Locale.ROOT);
        if (normalized.isBlank() || !normalized.contains("@") || normalized.length() > 255) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid email");
        }
        return normalized;
    }

    private static String normalizeMemberRole(String role) {
        String normalized = role == null ? "" : role.trim().toUpperCase(Locale.ROOT);
        if (!"ADMIN".equals(normalized) && !"EDITOR".equals(normalized) && !"VIEWER".equals(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid workspace role");
        }
        return normalized;
    }

    private Map<String, Object> workspaceView(Workspace workspace) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", workspace.getId());
        out.put("name", workspace.getName());
        out.put("ownerUserId", workspace.getOwnerUserId());
        out.put("createdAt", workspace.getCreatedAt() == null ? null : workspace.getCreatedAt().toString());
        return out;
    }

    private Map<String, Object> memberView(WorkspaceMember member) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", member.getId());
        out.put("workspaceId", member.getWorkspaceId());
        out.put("userId", member.getUserId());
        out.put("role", member.getRole());
        out.put("createdAt", member.getCreatedAt() == null ? null : member.getCreatedAt().toString());
        userAccountRepository.findById(member.getUserId()).ifPresent(user -> {
            out.put("username", user.getUsername());
            out.put("email", user.getEmail());
        });
        return out;
    }

    private Map<String, Object> inviteView(WorkspaceInvite invite) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", invite.getId());
        out.put("workspaceId", invite.getWorkspaceId());
        out.put("email", invite.getEmail());
        out.put("role", invite.getRole());
        out.put("status", invite.getStatus());
        out.put("createdAt", invite.getCreatedAt() == null ? null : invite.getCreatedAt().toString());
        return out;
    }
}
