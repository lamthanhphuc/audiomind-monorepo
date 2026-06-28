package com.example.userservice.notification;

import com.example.userservice.entity.UserNotification;
import com.example.userservice.repository.UserNotificationRepository;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

@Service
@RequiredArgsConstructor
@Slf4j
public class JobStatusNotificationService {

    private final UserNotificationService userNotificationService;
    private final UserNotificationRepository notificationRepository;

    public UserNotification notifyJobStatus(JobStatusNotificationRequest request) {
        if (request.userId() == null || request.meetingId() == null) {
            return null;
        }

        String normalizedStatus = request.status() == null ? "" : request.status().trim().toUpperCase();
        if (!"COMPLETED".equals(normalizedStatus) && !"FAILED".equals(normalizedStatus)) {
            return null;
        }

        String type = "COMPLETED".equals(normalizedStatus)
                ? UserNotificationService.TYPE_JOB_COMPLETED
                : UserNotificationService.TYPE_JOB_FAILED;

        if (notificationRepository.existsByUserIdAndTypeAndMeetingId(
                request.userId(),
                type,
                meetingIdPayloadPattern(request.meetingId())
        )) {
            log.info(
                    "event=JOB_STATUS_NOTIFICATION_SKIPPED reason=duplicate userId={} meetingId={} status={}",
                    request.userId(),
                    request.meetingId(),
                    normalizedStatus
            );
            return null;
        }

        String meetingTitle = StringUtils.hasText(request.meetingTitle())
                ? request.meetingTitle().trim()
                : ("Cuộc họp #" + request.meetingId());

        String title = "COMPLETED".equals(normalizedStatus)
                ? "Xử lý hoàn tất"
                : "Xử lý thất bại";
        String body = "COMPLETED".equals(normalizedStatus)
                ? String.format("Cuộc họp \"%s\" đã xử lý xong.", meetingTitle)
                : String.format(
                        "Cuộc họp \"%s\" xử lý thất bại.%s",
                        meetingTitle,
                        StringUtils.hasText(request.error()) ? " " + request.error().trim() : ""
                );

        UserNotification saved = userNotificationService.createNotification(
                request.userId(),
                type,
                title,
                body,
                Map.of(
                        "meetingId", request.meetingId(),
                        "meetingTitle", meetingTitle,
                        "status", normalizedStatus
                )
        );

        log.info(
                "event=JOB_STATUS_NOTIFICATION_SENT userId={} meetingId={} status={} notificationId={}",
                request.userId(),
                request.meetingId(),
                normalizedStatus,
                saved.getId()
        );
        return saved;
    }

    private static String meetingIdPayloadPattern(Long meetingId) {
        return "%\"meetingId\":" + meetingId + "%";
    }

    public record JobStatusNotificationRequest(
            Long userId,
            Long meetingId,
            String meetingTitle,
            String status,
            String error
    ) {
    }
}
