package com.example.meetingservice.scheduler;

import com.example.meetingservice.client.TaskReminderClient;
import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.entity.MeetingTask;
import com.example.meetingservice.repository.MeetingRepository;
import com.example.meetingservice.repository.MeetingTaskRepository;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

@Component
@RequiredArgsConstructor
@Slf4j
public class TaskReminderScheduler {

    private final MeetingTaskRepository taskRepository;
    private final MeetingRepository meetingRepository;
    private final TaskReminderClient taskReminderClient;

    @Scheduled(cron = "${app.task-reminder.cron:0 0 8 * * *}")
    public void dispatchDueTaskReminders() {
        List<MeetingTask> candidates = taskRepository.findAll().stream()
                .filter(task -> !"done".equalsIgnoreCase(task.getStatus()))
                .filter(task -> StringUtils.hasText(task.getDeadline()))
                .filter(this::isDueSoon)
                .limit(100)
                .toList();
        for (MeetingTask task : candidates) {
            try {
                Meeting meeting = meetingRepository.findById(task.getMeetingId()).orElse(null);
                if (meeting == null || meeting.getOwnerUserId() == null) {
                    continue;
                }
                taskReminderClient.sendTaskReminder(
                        meeting.getOwnerUserId(),
                        task.getMeetingId(),
                        task.getId(),
                        meeting.getTitle(),
                        task.getTitle(),
                        task.getDeadline(),
                        task.getStatus()
                );
            } catch (Exception ex) {
                log.warn("event=TASK_REMINDER_DISPATCH_FAILED taskId={} error={}", task.getId(), ex.getMessage());
            }
        }
    }

    private boolean isDueSoon(MeetingTask task) {
        String deadline = task.getDeadline().trim();
        try {
            LocalDate dueDate = LocalDate.parse(deadline);
            LocalDate today = LocalDate.now();
            return !dueDate.isBefore(today) && !dueDate.isAfter(today.plusDays(2));
        } catch (Exception ignored) {
            return task.getUpdatedAt() != null
                    && task.getUpdatedAt().isAfter(LocalDateTime.now().minusDays(7));
        }
    }
}
