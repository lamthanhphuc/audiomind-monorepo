package com.example.userservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.client.MeetingClient;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.Workspace;
import com.example.userservice.entity.WorkspaceMember;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.WorkspaceInviteRepository;
import com.example.userservice.repository.WorkspaceMemberRepository;
import com.example.userservice.repository.WorkspaceRepository;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;

class WorkspaceServiceTest {

    @Test
    void createsDefaultWorkspaceForUserWithoutMembership() {
        WorkspaceRepository workspaceRepository = mock(WorkspaceRepository.class);
        WorkspaceMemberRepository memberRepository = mock(WorkspaceMemberRepository.class);
        WorkspaceInviteRepository inviteRepository = mock(WorkspaceInviteRepository.class);
        UserAccountRepository userRepository = mock(UserAccountRepository.class);
        MeetingClient meetingClient = mock(MeetingClient.class);
        AuditEventService auditEventService = mock(AuditEventService.class);
        WorkspaceService service = new WorkspaceService(
                workspaceRepository,
                memberRepository,
                inviteRepository,
                userRepository,
                meetingClient,
                auditEventService
        );

        UserAccount user = new UserAccount();
        user.setId(10L);
        user.setUsername("linh");
        user.setEmail("linh@example.com");
        Workspace saved = new Workspace();
        saved.setId(99L);
        saved.setName("linh workspace");
        saved.setOwnerUserId(10L);

        when(memberRepository.findByUserIdOrderByCreatedAtAsc(10L)).thenReturn(List.of());
        when(workspaceRepository.save(any(Workspace.class))).thenReturn(saved);
        when(memberRepository.findByWorkspaceIdOrderByCreatedAtAsc(99L)).thenReturn(List.of());
        when(inviteRepository.findByWorkspaceIdAndStatusOrderByCreatedAtDesc(99L, "PENDING")).thenReturn(List.of());
        when(meetingClient.getWorkspaceSummary(10L, "linh@example.com")).thenReturn(Map.of(
                "ownedMeetingCount", 2,
                "sharedWithMeCount", 1,
                "sharedMeetings", List.of()
        ));

        Map<String, Object> result = service.getMyWorkspace(user);

        assertEquals(2, result.get("ownedMeetingCount"));
        verify(memberRepository).save(any(WorkspaceMember.class));
    }

    @Test
    void addsExistingUserAsWorkspaceMember() {
        WorkspaceRepository workspaceRepository = mock(WorkspaceRepository.class);
        WorkspaceMemberRepository memberRepository = mock(WorkspaceMemberRepository.class);
        WorkspaceInviteRepository inviteRepository = mock(WorkspaceInviteRepository.class);
        UserAccountRepository userRepository = mock(UserAccountRepository.class);
        MeetingClient meetingClient = mock(MeetingClient.class);
        AuditEventService auditEventService = mock(AuditEventService.class);
        WorkspaceService service = new WorkspaceService(
                workspaceRepository,
                memberRepository,
                inviteRepository,
                userRepository,
                meetingClient,
                auditEventService
        );

        Workspace workspace = new Workspace();
        workspace.setId(5L);
        workspace.setOwnerUserId(1L);
        WorkspaceMember actor = new WorkspaceMember();
        actor.setWorkspaceId(5L);
        actor.setUserId(1L);
        actor.setRole("ADMIN");
        UserAccount invitee = new UserAccount();
        invitee.setId(22L);
        invitee.setEmail("dev@example.com");

        when(workspaceRepository.findById(5L)).thenReturn(Optional.of(workspace));
        when(memberRepository.findByWorkspaceIdAndUserId(5L, 1L)).thenReturn(Optional.of(actor));
        when(userRepository.findByEmailIgnoreCase("dev@example.com")).thenReturn(Optional.of(invitee));
        when(userRepository.findById(22L)).thenReturn(Optional.of(invitee));
        when(memberRepository.findByWorkspaceIdAndUserId(5L, 22L)).thenReturn(Optional.empty());
        when(memberRepository.save(any(WorkspaceMember.class))).thenAnswer(invocation -> invocation.getArgument(0));

        Map<String, Object> result = service.inviteOrAddMember(1L, 5L, "Dev@Example.com", "editor");

        @SuppressWarnings("unchecked")
        Map<String, Object> member = (Map<String, Object>) result.get("member");
        assertEquals(22L, member.get("userId"));
        assertEquals("EDITOR", member.get("role"));
        verify(auditEventService).record(eq(1L), eq("WORKSPACE_MEMBER_ADDED"), eq("WORKSPACE"), eq("5"), eq("Workspace member added"), any());
    }
}
