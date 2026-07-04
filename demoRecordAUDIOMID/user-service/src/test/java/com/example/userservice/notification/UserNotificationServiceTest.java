package com.example.userservice.notification;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.UserNotification;
import com.example.userservice.repository.UserNotificationRepository;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class UserNotificationServiceTest {

    @Mock
    private UserNotificationRepository notificationRepository;

    @Mock
    private NotificationEventHub notificationEventHub;

    @InjectMocks
    private UserNotificationService userNotificationService;

    @Test
    void createNotification_shouldPersistShareInvite() {
        when(notificationRepository.save(any(UserNotification.class))).thenAnswer(invocation -> {
            UserNotification saved = invocation.getArgument(0);
            saved.setId(99L);
            return saved;
        });
        when(notificationRepository.countByUserIdAndReadAtIsNull(12L)).thenReturn(1L);

        UserNotification created = userNotificationService.createNotification(
                12L,
                UserNotificationService.TYPE_MEETING_SHARE_INVITE,
                "Chia sẻ cuộc họp",
                "Bạn được mời xem",
                Map.of("meetingId", 501L)
        );

        assertEquals(99L, created.getId());
        ArgumentCaptor<UserNotification> captor = ArgumentCaptor.forClass(UserNotification.class);
        verify(notificationRepository).save(captor.capture());
        assertEquals(12L, captor.getValue().getUserId());
        assertEquals(UserNotificationService.TYPE_MEETING_SHARE_INVITE, captor.getValue().getType());
    }

    @Test
    void markRead_shouldSetReadAtWhenUnread() {
        UserNotification notification = new UserNotification();
        notification.setId(7L);
        notification.setUserId(3L);
        notification.setType(UserNotificationService.TYPE_MEETING_SHARE_INVITE);
        notification.setTitle("title");
        when(notificationRepository.findByIdAndUserId(7L, 3L)).thenReturn(Optional.of(notification));
        when(notificationRepository.save(notification)).thenReturn(notification);

        Map<String, Object> view = userNotificationService.markRead(3L, 7L);

        assertTrue((Boolean) view.get("read"));
        verify(notificationRepository).save(notification);
    }

    @Test
    void unreadCount_shouldReturnRepositoryCount() {
        when(notificationRepository.countByUserIdAndReadAtIsNull(5L)).thenReturn(4L);
        assertEquals(4L, userNotificationService.unreadCount(5L));
    }

    @Test
    void listNotifications_shouldRespectUnreadOnlyFilter() {
        UserNotification unread = new UserNotification();
        unread.setId(1L);
        unread.setUserId(2L);
        unread.setType(UserNotificationService.TYPE_JOB_COMPLETED);
        unread.setTitle("Xong");
        unread.setCreatedAt(Instant.parse("2026-06-01T00:00:00Z"));
        when(notificationRepository.findForUser(2L, true)).thenReturn(List.of(unread));

        List<Map<String, Object>> items = userNotificationService.listNotifications(2L, true, 10);

        assertEquals(1, items.size());
        assertFalse((Boolean) items.get(0).get("read"));
        verify(notificationRepository).findForUser(eq(2L), eq(true));
    }
}
