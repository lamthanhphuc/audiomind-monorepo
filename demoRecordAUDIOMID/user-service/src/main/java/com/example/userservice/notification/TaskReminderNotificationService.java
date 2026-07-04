package com.example.userservice.notification;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.UserAccountRepository;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mail.MailException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

@Service
@RequiredArgsConstructor
@Slf4j
public class TaskReminderNotificationService {

    private final UserAccountRepository userAccountRepository;
    private final NotificationProperties notificationProperties;
    private final UserNotificationService userNotificationService;

    @Autowired(required = false)
    private JavaMailSender mailSender;

    public void notifyTaskReminder(TaskReminderNotificationRequest request) {
        if (!notificationProperties.isTaskReminderEnabled()) {
            log.info("event=TASK_REMINDER_SKIPPED reason=disabled userId={} meetingId={}", request.userId(), request.meetingId());
            return;
        }
        UserAccount user = userAccountRepository.findById(request.userId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        String meetingTitle = StringUtils.hasText(request.meetingTitle())
                ? request.meetingTitle().trim()
                : ("Cuộc họp #" + request.meetingId());
        String title = "Nhắc việc: " + request.taskTitle();
        String body = String.format(
                "Task \"%s\" trong \"%s\" có deadline %s (trạng thái: %s).",
                request.taskTitle(),
                meetingTitle,
                StringUtils.hasText(request.deadline()) ? request.deadline() : "chưa có",
                StringUtils.hasText(request.status()) ? request.status() : "open"
        );
        userNotificationService.createNotification(
                request.userId(),
                "TASK_REMINDER",
                title,
                body,
                Map.of(
                        "meetingId", request.meetingId(),
                        "taskId", request.taskId(),
                        "taskTitle", request.taskTitle()
                )
        );
        sendEmail(user, title, body, request.meetingId());
    }

    private void sendEmail(UserAccount user, String subject, String body, Long meetingId) {
        if (mailSender == null || !StringUtils.hasText(user.getEmail())) {
            return;
        }
        try {
            SimpleMailMessage message = new SimpleMailMessage();
            message.setTo(user.getEmail());
            message.setFrom(notificationProperties.getFromEmail());
            message.setSubject(subject);
            message.setText(body + "\n\nMở meeting: " + buildMeetingDeepLink(meetingId) + "\n\n— AudioMind");
            mailSender.send(message);
        } catch (MailException ex) {
            log.warn("event=TASK_REMINDER_EMAIL_FAILED userId={} meetingId={} error={}", user.getId(), meetingId, ex.getMessage());
        }
    }

    private String buildMeetingDeepLink(Long meetingId) {
        String base = notificationProperties.getFrontendBaseUrl();
        if (!StringUtils.hasText(base)) {
            return "http://localhost:8080";
        }
        return base.replaceAll("/$", "") + "/?meetingId=" + meetingId;
    }

    public record TaskReminderNotificationRequest(
            Long userId,
            Long meetingId,
            Long taskId,
            String meetingTitle,
            String taskTitle,
            String deadline,
            String status
    ) {
    }
}
