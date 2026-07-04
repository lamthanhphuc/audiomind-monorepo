package com.example.userservice.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserNotification;
import com.example.userservice.repository.UserAccountRepository;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class MeetingShareNotificationServiceTest {

    @Mock
    private UserAccountRepository userAccountRepository;
    @Mock
    private NotificationProperties notificationProperties;
    @Mock
    private UserNotificationService userNotificationService;
    @Mock
    private ShareEmailSender shareEmailSender;
    @Mock
    private ShareInviterLabelResolver inviterLabelResolver;
    @Mock
    private ShareInviteEmailComposer shareInviteEmailComposer;
    @Mock
    private ShareInviteLinkResolver shareInviteLinkResolver;

    @InjectMocks
    private MeetingShareNotificationService service;

    @Test
    void notifyPendingMeetingShareInvite_delegatesComposedHtmlEmail() {
        when(notificationProperties.isMeetingShareEnabled()).thenReturn(true);
        UserAccount inviter = new UserAccount();
        inviter.setUsername("owner");
        when(userAccountRepository.findById(1L)).thenReturn(Optional.of(inviter));
        when(inviterLabelResolver.resolve(inviter)).thenReturn("owner");
        when(shareInviteLinkResolver.registerUrl(10L)).thenReturn("http://localhost:8080/register?openMeeting=10");
        when(shareInviteLinkResolver.isLocalDevBaseUrl()).thenReturn(true);
        ShareInviteEmailContent content = new ShareInviteEmailContent(
                "owner đã chia sẻ cuộc họp với bạn",
                "plain",
                "<html>invite</html>"
        );
        when(shareInviteEmailComposer.composePendingInvite(
                eq("owner"), eq("Weekly sync"), eq("VIEWER"), eq("http://localhost:8080/register?openMeeting=10")))
                .thenReturn(content);
        when(shareEmailSender.sendMeetingShareEmail(eq(1L), eq("guest@example.com"), eq(content)))
                .thenReturn(ShareEmailResult.sent("GMAIL", false, List.of(), "msg-1"));

        ShareEmailResult result = service.notifyPendingMeetingShareInvite(
                new MeetingShareNotificationService.PendingMeetingShareNotificationRequest(
                        "guest@example.com",
                        1L,
                        10L,
                        "Weekly sync",
                        "VIEWER"
                )
        );

        assertThat(result.sent()).isTrue();
        assertThat(result.channel()).isEqualTo("GMAIL");
        verify(shareEmailSender).sendMeetingShareEmail(eq(1L), eq("guest@example.com"), eq(content));
    }

    @Test
    void notifyMeetingShare_sendsInAppAndHtmlEmail() {
        when(notificationProperties.isMeetingShareEnabled()).thenReturn(true);
        UserAccount invitee = new UserAccount();
        invitee.setUsername("guest");
        invitee.setEmail("guest@example.com");
        UserAccount inviter = new UserAccount();
        inviter.setUsername("owner");
        when(userAccountRepository.findById(22L)).thenReturn(Optional.of(invitee));
        when(userAccountRepository.findById(1L)).thenReturn(Optional.of(inviter));
        when(inviterLabelResolver.resolve(inviter)).thenReturn("owner");
        when(inviterLabelResolver.resolve(invitee)).thenReturn("guest");
        when(shareInviteLinkResolver.meetingUrl(10L)).thenReturn("http://localhost:8080/?openMeeting=10");
        ShareInviteEmailContent content = new ShareInviteEmailContent("subject", "plain", "<html>share</html>");
        when(shareInviteEmailComposer.composeMeetingShare(
                eq("guest"), eq("owner"), eq("Weekly sync"), eq("VIEWER"), eq("http://localhost:8080/?openMeeting=10")))
                .thenReturn(content);
        UserNotification notification = new UserNotification();
        notification.setId(99L);
        when(userNotificationService.createNotification(any(), any(), any(), any(), any()))
                .thenReturn(notification);
        when(shareEmailSender.sendMeetingShareEmail(eq(1L), eq("guest@example.com"), eq(content)))
                .thenReturn(ShareEmailResult.sent("SMTP", true, List.of("gmail.send"), null));

        MeetingShareNotificationService.MeetingShareNotificationResult result = service.notifyMeetingShare(
                new MeetingShareNotificationService.MeetingShareNotificationRequest(
                        22L,
                        1L,
                        10L,
                        "Weekly sync",
                        "VIEWER"
                )
        );

        assertThat(result.notification().getId()).isEqualTo(99L);
        assertThat(result.emailResult().channel()).isEqualTo("SMTP");
    }
}
