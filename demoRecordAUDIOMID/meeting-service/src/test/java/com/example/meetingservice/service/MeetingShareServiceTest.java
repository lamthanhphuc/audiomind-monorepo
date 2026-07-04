package com.example.meetingservice.service;

import com.example.meetingservice.client.InternalUserLookupClient;
import com.example.meetingservice.client.ShareNotificationClient;
import com.example.meetingservice.client.ShareNotificationResponse;
import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.entity.MeetingShare;
import com.example.meetingservice.entity.MeetingShareInvite;
import com.example.meetingservice.repository.MeetingRepository;
import com.example.meetingservice.repository.MeetingShareInviteRepository;
import com.example.meetingservice.repository.MeetingShareRepository;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class MeetingShareServiceTest {

    @Mock
    private MeetingRepository meetingRepository;

    @Mock
    private MeetingShareRepository meetingShareRepository;

    @Mock
    private MeetingShareInviteRepository meetingShareInviteRepository;

    @Mock
    private InternalUserLookupClient userLookupClient;

    @Mock
    private ShareNotificationClient shareNotificationClient;

    @InjectMocks
    private MeetingShareService meetingShareService;

    @Test
    void inviteByEmail_shouldCreatePendingInviteWhenUserDoesNotExist() {
        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setTitle("Weekly sync");
        meeting.setOwnerUserId(1L);

        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 1L)).thenReturn(Optional.of(meeting));
        when(userLookupClient.lookupByUserIdOptional(1L)).thenReturn(Optional.of(Map.of(
                "userId", 1L,
                "email", "owner@example.com",
                "username", "owner"
        )));
        when(userLookupClient.lookupByEmailOptional("guest@example.com")).thenReturn(Optional.empty());
        when(meetingShareInviteRepository.findByMeetingIdAndInviteeEmailAndStatus(
                10L,
                "guest@example.com",
                MeetingShareService.STATUS_PENDING
        )).thenReturn(Optional.empty());
        when(meetingRepository.findById(10L)).thenReturn(Optional.of(meeting));
        when(shareNotificationClient.notifyPendingMeetingShareInvite(
                eq("guest@example.com"),
                eq(1L),
                eq(10L),
                eq("Weekly sync"),
                eq(MeetingShareService.ROLE_VIEWER)
        )).thenReturn(new ShareNotificationResponse(true, "GMAIL", false, List.of(), "sender@gmail.com"));

        MeetingShareInvite savedInvite = new MeetingShareInvite();
        savedInvite.setId(99L);
        savedInvite.setMeetingId(10L);
        savedInvite.setInviteeEmail("guest@example.com");
        savedInvite.setRole(MeetingShareService.ROLE_VIEWER);
        savedInvite.setInvitedByUserId(1L);
        savedInvite.setStatus(MeetingShareService.STATUS_PENDING);
        savedInvite.setCreatedAt(LocalDateTime.now());
        when(meetingShareInviteRepository.save(any(MeetingShareInvite.class))).thenReturn(savedInvite);

        Map<String, Object> result = meetingShareService.inviteByEmail(10L, 1L, "guest@example.com", "VIEWER");

        assertEquals(MeetingShareService.STATUS_PENDING, result.get("status"));
        assertEquals("guest@example.com", result.get("email"));
        assertEquals(true, result.get("emailSent"));
        assertEquals("GMAIL", result.get("emailChannel"));
        verify(shareNotificationClient).notifyPendingMeetingShareInvite(
                eq("guest@example.com"),
                eq(1L),
                eq(10L),
                eq("Weekly sync"),
                eq(MeetingShareService.ROLE_VIEWER)
        );
        verify(meetingShareRepository, never()).save(any(MeetingShare.class));
    }

    @Test
    void inviteByEmail_shouldRejectSelfInviteForPendingEmail() {
        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setOwnerUserId(1L);

        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 1L)).thenReturn(Optional.of(meeting));
        when(userLookupClient.lookupByUserIdOptional(1L)).thenReturn(Optional.of(Map.of(
                "userId", 1L,
                "email", "owner@example.com",
                "username", "owner"
        )));

        assertThrows(
                ResponseStatusException.class,
                () -> meetingShareService.inviteByEmail(10L, 1L, "owner@example.com", "VIEWER")
        );
    }

    @Test
    void acceptPendingInvitesForUser_shouldCreateShareAndNotifyInvitee() {
        MeetingShareInvite invite = new MeetingShareInvite();
        invite.setId(5L);
        invite.setMeetingId(10L);
        invite.setInviteeEmail("guest@example.com");
        invite.setRole(MeetingShareService.ROLE_VIEWER);
        invite.setInvitedByUserId(1L);
        invite.setStatus(MeetingShareService.STATUS_PENDING);

        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setTitle("Weekly sync");
        meeting.setOwnerUserId(1L);
        meeting.setDeletedAt(null);

        when(meetingShareInviteRepository.findByInviteeEmailAndStatusOrderByCreatedAtAsc(
                "guest@example.com",
                MeetingShareService.STATUS_PENDING
        )).thenReturn(List.of(invite));
        when(meetingRepository.findById(10L)).thenReturn(Optional.of(meeting));
        when(meetingShareRepository.existsByMeetingIdAndSharedWithUserId(10L, 22L)).thenReturn(false);

        Map<String, Object> result = meetingShareService.acceptPendingInvitesForUser(22L, "guest@example.com");

        assertEquals(1, result.get("acceptedCount"));
        verify(meetingShareRepository).save(any(MeetingShare.class));
        verify(shareNotificationClient).notifyMeetingShare(
                eq(22L),
                eq(1L),
                eq(10L),
                eq("Weekly sync"),
                eq(MeetingShareService.ROLE_VIEWER)
        );
        assertEquals(MeetingShareService.STATUS_ACCEPTED, invite.getStatus());
        verify(meetingShareInviteRepository).saveAll(any());
    }

    @Test
    void listShares_shouldEnrichActiveSharesWithEmailAndUsername() {
        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setOwnerUserId(1L);

        MeetingShare share = new MeetingShare();
        share.setId(1L);
        share.setMeetingId(10L);
        share.setSharedWithUserId(3L);
        share.setRole(MeetingShareService.ROLE_VIEWER);
        share.setInvitedByUserId(1L);
        share.setCreatedAt(LocalDateTime.now());

        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 1L)).thenReturn(Optional.of(meeting));
        when(meetingShareRepository.findByMeetingIdOrderByCreatedAtAsc(10L)).thenReturn(List.of(share));
        when(meetingShareInviteRepository.findByMeetingIdAndStatusOrderByCreatedAtAsc(
                10L,
                MeetingShareService.STATUS_PENDING
        )).thenReturn(List.of());
        when(userLookupClient.lookupByUserIdOptional(3L)).thenReturn(Optional.of(Map.of(
                "userId", 3L,
                "email", "bob@example.com",
                "username", "bob"
        )));

        List<Map<String, Object>> views = meetingShareService.listShares(10L, 1L);

        assertEquals(1, views.size());
        assertEquals("bob@example.com", views.get(0).get("email"));
        assertEquals("bob", views.get(0).get("username"));
        assertEquals(MeetingShareService.STATUS_ACTIVE, views.get(0).get("status"));
    }

    @Test
    void inviteByEmail_shouldResendNotificationWhenPendingInviteExists() {
        Meeting meeting = new Meeting();
        meeting.setId(10L);
        meeting.setTitle("Weekly sync");
        meeting.setOwnerUserId(1L);

        MeetingShareInvite existingInvite = new MeetingShareInvite();
        existingInvite.setId(99L);
        existingInvite.setMeetingId(10L);
        existingInvite.setInviteeEmail("guest@example.com");
        existingInvite.setRole(MeetingShareService.ROLE_VIEWER);
        existingInvite.setInvitedByUserId(1L);
        existingInvite.setStatus(MeetingShareService.STATUS_PENDING);
        existingInvite.setCreatedAt(LocalDateTime.now());

        when(meetingRepository.findByIdAndOwnerUserIdAndDeletedAtIsNull(10L, 1L)).thenReturn(Optional.of(meeting));
        when(userLookupClient.lookupByUserIdOptional(1L)).thenReturn(Optional.of(Map.of(
                "userId", 1L,
                "email", "owner@example.com",
                "username", "owner"
        )));
        when(userLookupClient.lookupByEmailOptional("guest@example.com")).thenReturn(Optional.empty());
        when(meetingShareInviteRepository.findByMeetingIdAndInviteeEmailAndStatus(
                10L,
                "guest@example.com",
                MeetingShareService.STATUS_PENDING
        )).thenReturn(Optional.of(existingInvite));
        when(meetingRepository.findById(10L)).thenReturn(Optional.of(meeting));
        when(shareNotificationClient.notifyPendingMeetingShareInvite(
                eq("guest@example.com"),
                eq(1L),
                eq(10L),
                eq("Weekly sync"),
                eq(MeetingShareService.ROLE_VIEWER)
        )).thenReturn(new ShareNotificationResponse(true, "SMTP", true, List.of("gmail.send"), null));

        Map<String, Object> result = meetingShareService.inviteByEmail(10L, 1L, "guest@example.com", "VIEWER");

        assertEquals(MeetingShareService.STATUS_PENDING, result.get("status"));
        assertEquals(true, result.get("emailSent"));
        assertEquals("SMTP", result.get("emailChannel"));
        assertEquals(true, result.get("requiresGmailScope"));
        verify(meetingShareInviteRepository, never()).save(any(MeetingShareInvite.class));
        verify(shareNotificationClient).notifyPendingMeetingShareInvite(
                eq("guest@example.com"),
                eq(1L),
                eq(10L),
                eq("Weekly sync"),
                eq(MeetingShareService.ROLE_VIEWER)
        );
    }
}
