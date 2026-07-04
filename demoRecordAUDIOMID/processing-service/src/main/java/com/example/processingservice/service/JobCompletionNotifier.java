package com.example.processingservice.service;

import com.example.processingservice.client.JobNotificationClient;
import com.example.processingservice.client.MeetingServiceClient;
import java.util.Map;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

@Service
@RequiredArgsConstructor
@Slf4j
public class JobCompletionNotifier {

    private static final Set<String> TERMINAL_STATUSES = Set.of("COMPLETED", "FAILED");

    private final JobStateStore jobStateStore;
    private final JobNotificationClient jobNotificationClient;
    private final MeetingServiceClient meetingServiceClient;

    public void maybeNotify(
            Long meetingId,
            String status,
            String error,
            String traceId,
            String authorization
    ) {
        if (meetingId == null || !StringUtils.hasText(authorization)) {
            return;
        }

        String normalizedStatus = status == null ? "" : status.trim().toUpperCase();
        if (!TERMINAL_STATUSES.contains(normalizedStatus)) {
            return;
        }
        if (!jobStateStore.claimJobStatusNotification(meetingId, normalizedStatus)) {
            return;
        }

        try {
            Map<String, Object> meeting = meetingServiceClient.getMeetingById(meetingId, traceId, authorization);
            Long ownerUserId = parseLong(meeting.get("ownerUserId"));
            if (ownerUserId == null) {
                log.warn(
                        "event=JOB_STATUS_NOTIFICATION_SKIPPED reason=missing_owner meetingId={} status={}",
                        meetingId,
                        normalizedStatus
                );
                return;
            }

            String meetingTitle = meeting.get("title") == null ? null : String.valueOf(meeting.get("title"));
            jobNotificationClient.notifyJobStatus(
                    ownerUserId,
                    meetingId,
                    meetingTitle,
                    normalizedStatus,
                    error
            );
        } catch (Exception ex) {
            log.warn(
                    "event=JOB_STATUS_NOTIFICATION_SKIPPED reason=meeting_lookup_failed meetingId={} status={} errorCode={}",
                    meetingId,
                    normalizedStatus,
                    ex.getClass().getSimpleName()
            );
        }
    }

    private static Long parseLong(Object value) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value instanceof String text && !text.isBlank()) {
            try {
                return Long.parseLong(text.trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }
}
