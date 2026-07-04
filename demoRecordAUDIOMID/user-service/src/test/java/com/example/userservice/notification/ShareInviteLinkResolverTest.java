package com.example.userservice.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.Mockito;

@ExtendWith(MockitoExtension.class)
class ShareInviteLinkResolverTest {

    @Mock
    private NotificationProperties notificationProperties;

    private ShareInviteLinkResolver resolver;

    @BeforeEach
    void setUp() {
        resolver = new ShareInviteLinkResolver(notificationProperties);
    }

    @Test
    void registerUrl_includesOpenMeetingQuery() {
        Mockito.when(notificationProperties.getFrontendBaseUrl()).thenReturn("https://app.example.com/");

        assertThat(resolver.registerUrl(15L)).isEqualTo("https://app.example.com/register?openMeeting=15");
    }

    @Test
    void registerUrl_rejectsInvalidMeetingId() {
        assertThatThrownBy(() -> resolver.registerUrl(null))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> resolver.registerUrl(0L))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void meetingUrl_buildsOpenMeetingDeepLink() {
        Mockito.when(notificationProperties.getFrontendBaseUrl()).thenReturn("https://app.example.com");

        assertThat(resolver.meetingUrl(15L)).isEqualTo("https://app.example.com/?openMeeting=15");
    }

    @Test
    void isLocalDevBaseUrl_detectsLocalhost() {
        Mockito.when(notificationProperties.getFrontendBaseUrl()).thenReturn("http://localhost:8080");

        assertThat(resolver.isLocalDevBaseUrl()).isTrue();
    }
}
