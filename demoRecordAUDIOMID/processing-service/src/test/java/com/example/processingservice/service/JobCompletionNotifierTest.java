package com.example.processingservice.service;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.processingservice.client.JobNotificationClient;
import com.example.processingservice.client.MeetingServiceClient;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class JobCompletionNotifierTest {

    @Mock
    private JobStateStore jobStateStore;

    @Mock
    private JobNotificationClient jobNotificationClient;

    @Mock
    private MeetingServiceClient meetingServiceClient;

    @InjectMocks
    private JobCompletionNotifier jobCompletionNotifier;

    private static final String AUTH = "Bearer token";

    @Test
    void maybeNotify_shouldSendWhenTerminalStatusClaimed() {
        when(jobStateStore.claimJobStatusNotification(42L, "COMPLETED")).thenReturn(true);
        when(meetingServiceClient.getMeetingById(42L, "trace-1", AUTH)).thenReturn(Map.of(
                "id", 42L,
                "ownerUserId", 7L,
                "title", "Weekly sync"
        ));

        jobCompletionNotifier.maybeNotify(42L, "COMPLETED", null, "trace-1", AUTH);

        verify(jobNotificationClient).notifyJobStatus(7L, 42L, "Weekly sync", "COMPLETED", null);
    }

    @Test
    void maybeNotify_shouldSkipWhenAlreadyNotified() {
        when(jobStateStore.claimJobStatusNotification(42L, "FAILED")).thenReturn(false);

        jobCompletionNotifier.maybeNotify(42L, "FAILED", "boom", "trace-2", AUTH);

        verify(jobNotificationClient, never()).notifyJobStatus(anyLong(), anyLong(), anyString(), anyString(), anyString());
    }
}
