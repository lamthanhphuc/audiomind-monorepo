package com.example.userservice.controller;



import com.example.userservice.google.GoogleGrantService;
import com.example.userservice.notification.MeetingShareNotificationService;

import com.example.userservice.notification.MeetingShareNotificationService.MeetingShareNotificationRequest;

import com.example.userservice.notification.MeetingShareNotificationService.MeetingShareNotificationResult;

import com.example.userservice.notification.MeetingShareNotificationService.PendingMeetingShareNotificationRequest;

import com.example.userservice.notification.JobStatusNotificationService;

import com.example.userservice.notification.JobStatusNotificationService.JobStatusNotificationRequest;

import com.example.userservice.notification.ShareEmailResult;

import com.example.userservice.notification.TaskReminderNotificationService;

import com.example.userservice.notification.TaskReminderNotificationService.TaskReminderNotificationRequest;

import jakarta.validation.Valid;

import jakarta.validation.constraints.NotBlank;

import jakarta.validation.constraints.NotNull;

import java.util.HashMap;

import java.util.Map;

import lombok.RequiredArgsConstructor;

import org.springframework.beans.factory.annotation.Value;

import org.springframework.http.HttpStatus;

import org.springframework.web.bind.annotation.PostMapping;

import org.springframework.web.bind.annotation.RequestBody;

import org.springframework.web.bind.annotation.RequestHeader;

import org.springframework.web.bind.annotation.RequestMapping;

import org.springframework.web.bind.annotation.RestController;

import org.springframework.web.server.ResponseStatusException;



@RestController

@RequestMapping("/internal/notifications")

@RequiredArgsConstructor

public class InternalNotificationController {



    private final MeetingShareNotificationService meetingShareNotificationService;

    private final JobStatusNotificationService jobStatusNotificationService;

    private final TaskReminderNotificationService taskReminderNotificationService;

    private final GoogleGrantService grantService;



    @Value("${app.internal.service-token:}")

    private String internalServiceToken;



    @PostMapping("/meeting-share")

    public Map<String, Object> meetingShare(

            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,

            @Valid @RequestBody MeetingShareRequest request

    ) {

        requireInternalToken(token);

        MeetingShareNotificationResult result = meetingShareNotificationService.notifyMeetingShare(

                new MeetingShareNotificationRequest(

                        request.inviteeUserId(),

                        request.inviterUserId(),

                        request.meetingId(),

                        request.meetingTitle(),

                        request.role()

                )

        );

        if (result.notification() == null) {

            return Map.of("status", "skipped");

        }

        return toEmailResponse(result.emailResult(), result.notification().getId());

    }



    @PostMapping("/meeting-share-pending")

    public Map<String, Object> meetingSharePending(

            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,

            @Valid @RequestBody PendingMeetingShareRequest request

    ) {

        requireInternalToken(token);

        ShareEmailResult emailResult = meetingShareNotificationService.notifyPendingMeetingShareInvite(

                new PendingMeetingShareNotificationRequest(

                        request.inviteeEmail(),

                        request.inviterUserId(),

                        request.meetingId(),

                        request.meetingTitle(),

                        request.role()

                )

        );

        Map<String, Object> response = toEmailResponse(emailResult, null);
        if (emailResult.sent() && "GMAIL".equalsIgnoreCase(emailResult.channel())) {
            grantService.resolveGoogleProviderEmail(request.inviterUserId())
                    .ifPresent(email -> response.put("emailFrom", email));
        }
        return response;

    }



    @PostMapping("/job-status")

    public Map<String, Object> jobStatus(

            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,

            @Valid @RequestBody JobStatusRequest request

    ) {

        requireInternalToken(token);

        var notification = jobStatusNotificationService.notifyJobStatus(

                new JobStatusNotificationRequest(

                        request.userId(),

                        request.meetingId(),

                        request.meetingTitle(),

                        request.status(),

                        request.error()

                )

        );

        if (notification == null) {

            return Map.of("status", "skipped");

        }

        return Map.of("status", "sent", "notificationId", notification.getId());

    }



    @PostMapping("/task-reminder")

    public Map<String, Object> taskReminder(

            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,

            @Valid @RequestBody TaskReminderRequest request

    ) {

        requireInternalToken(token);

        taskReminderNotificationService.notifyTaskReminder(

                new TaskReminderNotificationRequest(

                        request.userId(),

                        request.meetingId(),

                        request.taskId(),

                        request.meetingTitle(),

                        request.taskTitle(),

                        request.deadline(),

                        request.status()

                )

        );

        return Map.of("status", "sent");

    }



    private Map<String, Object> toEmailResponse(ShareEmailResult emailResult, Long notificationId) {

        Map<String, Object> response = new HashMap<>();

        response.put("status", emailResult.sent() ? "sent" : "skipped");

        response.put("channel", emailResult.channel());

        response.put("requiresGmailScope", emailResult.requiresGmailScope());

        response.put("missingScopes", emailResult.missingScopes());

        if (notificationId != null) {

            response.put("notificationId", notificationId);

        }

        return response;

    }



    private void requireInternalToken(String token) {

        if (internalServiceToken == null || internalServiceToken.isBlank()) {

            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Internal token not configured");

        }

        if (token == null || token.isBlank() || !internalServiceToken.equals(token)) {

            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");

        }

    }



    public record MeetingShareRequest(

            @NotNull Long inviteeUserId,

            @NotNull Long inviterUserId,

            @NotNull Long meetingId,

            String meetingTitle,

            @NotBlank String role

    ) {

    }



    public record PendingMeetingShareRequest(

            @NotBlank String inviteeEmail,

            @NotNull Long inviterUserId,

            @NotNull Long meetingId,

            String meetingTitle,

            @NotBlank String role

    ) {

    }



    public record JobStatusRequest(

            @NotNull Long userId,

            @NotNull Long meetingId,

            String meetingTitle,

            @NotBlank String status,

            String error

    ) {

    }



    public record TaskReminderRequest(

            @NotNull Long userId,

            @NotNull Long meetingId,

            @NotNull Long taskId,

            String meetingTitle,

            @NotBlank String taskTitle,

            String deadline,

            String status

    ) {

    }

}


