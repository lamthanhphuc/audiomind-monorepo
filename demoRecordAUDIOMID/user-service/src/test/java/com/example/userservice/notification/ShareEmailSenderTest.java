package com.example.userservice.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.google.GoogleGrantService;
import com.example.userservice.google.GoogleScopes;
import com.example.userservice.notification.gmail.GmailSendService;
import com.example.userservice.repository.UserAccountRepository;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ShareEmailSenderTest {

    @Mock
    private NotificationProperties notificationProperties;
    @Mock
    private GoogleGrantService grantService;
    @Mock
    private GmailSendService gmailSendService;
    @Mock
    private SmtpShareMailSender smtpShareMailSender;
    @Mock
    private UserAccountRepository userAccountRepository;

    @InjectMocks
    private ShareEmailSender shareEmailSender;

    @Test
    void sendMeetingShareEmail_passesHtmlToGmail() {
        when(notificationProperties.isGmailSendEnabled()).thenReturn(true);
        UserAccount inviter = new UserAccount();
        inviter.setEmail("owner@example.com");
        when(userAccountRepository.findById(1L)).thenReturn(Optional.of(inviter));
        ShareInviteEmailContent content = new ShareInviteEmailContent("Subject", "Plain", "<html>cta</html>");
        when(gmailSendService.sendMultipart(
                1L, "guest@example.com", "Subject", "Plain", "<html>cta</html>", "owner@example.com"))
                .thenReturn(Optional.of("msg-html"));

        ShareEmailResult result = shareEmailSender.sendMeetingShareEmail(1L, "guest@example.com", content);

        assertThat(result.sent()).isTrue();
        assertThat(result.channel()).isEqualTo("GMAIL");
    }

    @Test
    void sendMeetingShareEmail_usesGmailWhenAvailable() {
        when(notificationProperties.isGmailSendEnabled()).thenReturn(true);
        UserAccount inviter = new UserAccount();
        inviter.setEmail("owner@example.com");
        when(userAccountRepository.findById(1L)).thenReturn(Optional.of(inviter));
        when(gmailSendService.sendMultipart(1L, "guest@example.com", "Subject", "Body", null, "owner@example.com"))
                .thenReturn(Optional.of("msg-1"));

        ShareEmailResult result = shareEmailSender.sendMeetingShareEmail(
                1L,
                "guest@example.com",
                "Subject",
                "Body"
        );

        assertThat(result.sent()).isTrue();
        assertThat(result.channel()).isEqualTo("GMAIL");
        assertThat(result.requiresGmailScope()).isFalse();
    }

    @Test
    void sendMeetingShareEmail_skipsGmailWhenFlagDisabled() {
        when(notificationProperties.isGmailSendEnabled()).thenReturn(false);
        when(grantService.hasScope(1L, GoogleScopes.GMAIL_SEND)).thenReturn(false);
        UserAccount inviter = new UserAccount();
        inviter.setEmail("owner@example.com");
        when(userAccountRepository.findById(1L)).thenReturn(Optional.of(inviter));
        when(smtpShareMailSender.send("guest@example.com", "Subject", "Body", "owner@example.com"))
                .thenReturn(true);

        ShareEmailResult result = shareEmailSender.sendMeetingShareEmail(
                1L,
                "guest@example.com",
                "Subject",
                "Body"
        );

        assertThat(result.sent()).isTrue();
        assertThat(result.channel()).isEqualTo("SMTP");
        assertThat(result.requiresGmailScope()).isTrue();
    }

    @Test
    void sendMeetingShareEmail_fallsBackToSmtpWhenGmailUnavailable() {
        when(notificationProperties.isGmailSendEnabled()).thenReturn(true);
        UserAccount inviter = new UserAccount();
        inviter.setEmail("owner@example.com");
        when(userAccountRepository.findById(1L)).thenReturn(Optional.of(inviter));
        when(gmailSendService.sendMultipart(1L, "guest@example.com", "Subject", "Body", null, "owner@example.com"))
                .thenReturn(Optional.empty());
        when(grantService.hasScope(1L, GoogleScopes.GMAIL_SEND)).thenReturn(false);
        when(smtpShareMailSender.send("guest@example.com", "Subject", "Body", "owner@example.com"))
                .thenReturn(true);

        ShareEmailResult result = shareEmailSender.sendMeetingShareEmail(
                1L,
                "guest@example.com",
                "Subject",
                "Body"
        );

        assertThat(result.channel()).isEqualTo("SMTP");
        verify(smtpShareMailSender).send("guest@example.com", "Subject", "Body", "owner@example.com");
    }

    @Test
    void sendMeetingShareEmail_returnsSkippedWhenBothChannelsFail() {
        when(notificationProperties.isGmailSendEnabled()).thenReturn(true);
        when(gmailSendService.sendMultipart(1L, "guest@example.com", "Subject", "Body", null, null))
                .thenReturn(Optional.empty());
        when(grantService.hasScope(1L, GoogleScopes.GMAIL_SEND)).thenReturn(true);
        when(userAccountRepository.findById(1L)).thenReturn(Optional.empty());
        when(smtpShareMailSender.send("guest@example.com", "Subject", "Body", null))
                .thenReturn(false);

        ShareEmailResult result = shareEmailSender.sendMeetingShareEmail(
                1L,
                "guest@example.com",
                "Subject",
                "Body"
        );

        assertThat(result.sent()).isFalse();
        assertThat(result.channel()).isEqualTo("NONE");
        assertThat(result.requiresGmailScope()).isFalse();
    }
}
