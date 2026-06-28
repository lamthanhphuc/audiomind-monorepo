package com.example.userservice.notification;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.UserNotification;
import com.example.userservice.repository.UserNotificationRepository;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class JobStatusNotificationServiceTest {

    @Mock
    private UserNotificationService userNotificationService;

    @Mock
    private UserNotificationRepository notificationRepository;

    @InjectMocks
    private JobStatusNotificationService jobStatusNotificationService;

    @Test
    void notifyJobStatus_shouldCreateCompletedNotification() {
        when(notificationRepository.existsByUserIdAndTypeAndMeetingId(eq(5L), eq(UserNotificationService.TYPE_JOB_COMPLETED), any()))
                .thenReturn(false);
        UserNotification saved = new UserNotification();
        saved.setId(11L);
        when(userNotificationService.createNotification(
                eq(5L),
                eq(UserNotificationService.TYPE_JOB_COMPLETED),
                any(),
                any(),
                any()
        )).thenReturn(saved);

        UserNotification result = jobStatusNotificationService.notifyJobStatus(
                new JobStatusNotificationService.JobStatusNotificationRequest(
                        5L,
                        88L,
                        "Demo meeting",
                        "COMPLETED",
                        null
                )
        );

        assertEquals(11L, result.getId());
    }

    @Test
    void notifyJobStatus_shouldSkipDuplicateNotifications() {
        when(notificationRepository.existsByUserIdAndTypeAndMeetingId(
                eq(5L),
                eq(UserNotificationService.TYPE_JOB_FAILED),
                any()
        )).thenReturn(true);

        UserNotification result = jobStatusNotificationService.notifyJobStatus(
                new JobStatusNotificationService.JobStatusNotificationRequest(
                        5L,
                        88L,
                        "Demo meeting",
                        "FAILED",
                        "timeout"
                )
        );

        assertNull(result);
        verify(userNotificationService, never()).createNotification(any(), any(), any(), any(), any());
    }
}
