package com.example.userservice.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ShareInviteEmailComposerTest {

    @Mock
    private NotificationProperties notificationProperties;

    private ShareInviteEmailComposer composer;

    @BeforeEach
    void setUp() {
        when(notificationProperties.getBrandName()).thenReturn("AudioMind");
        when(notificationProperties.getBrandAccentColor()).thenReturn("#5b4bff");
        composer = new ShareInviteEmailComposer(notificationProperties);
    }

    @Test
    void composePendingInvite_includesRegisterLinkAndHtmlCta() {
        ShareInviteEmailContent content = composer.composePendingInvite(
                "Lâm Thanh Phúc",
                "Họp tuần",
                "VIEWER",
                "https://app.example.com/register"
        );

        assertThat(content.subject()).contains("Lâm Thanh Phúc");
        assertThat(content.plainText()).contains("https://app.example.com/register");
        assertThat(content.htmlBody()).contains("https://app.example.com/register");
        assertThat(content.htmlBody()).contains("Đăng ký &amp; nhận quyền truy cập");
        assertThat(content.htmlBody()).contains("#5b4bff");
        assertThat(content.htmlBody()).contains("AudioMind");
    }

    @Test
    void composeMeetingShare_includesMeetingDeepLink() {
        ShareInviteEmailContent content = composer.composeMeetingShare(
                "guest",
                "Owner",
                "Weekly sync",
                "EDITOR",
                "https://app.example.com/?openMeeting=42"
        );

        assertThat(content.plainText()).contains("https://app.example.com/?openMeeting=42");
        assertThat(content.htmlBody()).contains("Mở cuộc họp");
        assertThat(content.htmlBody()).contains("Weekly sync");
    }

    @Test
    void composePendingInvite_escapesHtmlInMeetingTitle() {
        ShareInviteEmailContent content = composer.composePendingInvite(
                "Owner",
                "<script>alert(1)</script>",
                "VIEWER",
                "https://app.example.com/register"
        );

        assertThat(content.htmlBody()).doesNotContain("<script>");
        assertThat(content.htmlBody()).contains("&lt;script&gt;");
    }
}
