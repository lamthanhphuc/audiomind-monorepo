package com.example.userservice.notification;



import com.example.userservice.entity.UserAccount;

import com.example.userservice.entity.UserNotification;

import com.example.userservice.repository.UserAccountRepository;

import java.util.Map;

import lombok.RequiredArgsConstructor;

import lombok.extern.slf4j.Slf4j;

import org.springframework.stereotype.Service;

import org.springframework.util.StringUtils;



@Service

@RequiredArgsConstructor

@Slf4j

public class MeetingShareNotificationService {



    private final UserAccountRepository userAccountRepository;

    private final NotificationProperties notificationProperties;

    private final UserNotificationService userNotificationService;

    private final ShareEmailSender shareEmailSender;

    private final ShareInviterLabelResolver inviterLabelResolver;

    private final ShareInviteEmailComposer shareInviteEmailComposer;

    private final ShareInviteLinkResolver shareInviteLinkResolver;



    public MeetingShareNotificationResult notifyMeetingShare(MeetingShareNotificationRequest request) {

        if (!notificationProperties.isMeetingShareEnabled()) {

            log.info(

                    "event=MEETING_SHARE_NOTIFICATION_SKIPPED reason=disabled meetingId={} inviteeUserId={}",

                    request.meetingId(),

                    request.inviteeUserId()

            );

            return MeetingShareNotificationResult.skippedOnly();

        }



        UserAccount invitee = userAccountRepository.findById(request.inviteeUserId())

                .orElseThrow(() -> new IllegalArgumentException("Invitee not found"));

        UserAccount inviter = userAccountRepository.findById(request.inviterUserId())

                .orElse(null);

        String inviterLabel = inviterLabelResolver.resolve(inviter);

        String inviteeLabel = inviterLabelResolver.resolve(invitee);

        String meetingTitle = meetingTitle(request.meetingTitle(), request.meetingId());

        String meetingUrl = shareInviteLinkResolver.meetingUrl(request.meetingId());

        String inAppTitle = inviterLabel + " đã chia sẻ cuộc họp với bạn";

        String inAppBody = String.format(

                "Bạn được mời xem \"%s\" với quyền %s.",

                meetingTitle,

                request.role()

        );



        UserNotification saved = userNotificationService.createNotification(

                request.inviteeUserId(),

                UserNotificationService.TYPE_MEETING_SHARE_INVITE,

                inAppTitle,

                inAppBody,

                Map.of(

                        "meetingId", request.meetingId(),

                        "inviterUserId", request.inviterUserId(),

                        "role", request.role(),

                        "meetingTitle", meetingTitle

                )

        );



        ShareInviteEmailContent emailContent = shareInviteEmailComposer.composeMeetingShare(

                inviteeLabel,

                inviterLabel,

                meetingTitle,

                request.role(),

                meetingUrl

        );

        log.info(

                "event=SHARE_INVITE_EMAIL_COMPOSED meetingId={} inviterLabel={} actionUrlHost={} hasHtml=true",

                request.meetingId(),

                inviterLabel,

                urlHost(meetingUrl)

        );



        ShareEmailResult emailResult = shareEmailSender.sendMeetingShareEmail(

                request.inviterUserId(),

                invitee.getEmail(),

                emailContent

        );

        log.info(

                "event=MEETING_SHARE_NOTIFICATION_SENT meetingId={} inviteeUserId={} notificationId={} emailSent={} emailChannel={} role={}",

                request.meetingId(),

                request.inviteeUserId(),

                saved.getId(),

                emailResult.sent(),

                emailResult.channel(),

                request.role()

        );

        return new MeetingShareNotificationResult(saved, emailResult);

    }



    public ShareEmailResult notifyPendingMeetingShareInvite(PendingMeetingShareNotificationRequest request) {

        if (!notificationProperties.isMeetingShareEnabled()) {

            log.info(

                    "event=MEETING_SHARE_PENDING_NOTIFICATION_SKIPPED reason=disabled meetingId={}",

                    request.meetingId()

            );

            return ShareEmailResult.skipped(false, java.util.List.of());

        }



        UserAccount inviter = userAccountRepository.findById(request.inviterUserId())

                .orElse(null);

        String inviterLabel = inviterLabelResolver.resolve(inviter);

        String meetingTitle = meetingTitle(request.meetingTitle(), request.meetingId());

        String registerUrl = shareInviteLinkResolver.registerUrl(request.meetingId());

        ShareInviteEmailContent emailContent = shareInviteEmailComposer.composePendingInvite(

                inviterLabel,

                meetingTitle,

                request.role(),

                registerUrl

        );

        log.info(

                "event=SHARE_INVITE_EMAIL_COMPOSED meetingId={} inviterLabel={} actionUrlHost={} localDevBase={} hasHtml=true",

                request.meetingId(),

                inviterLabel,

                urlHost(registerUrl),

                shareInviteLinkResolver.isLocalDevBaseUrl()

        );



        ShareEmailResult emailResult = shareEmailSender.sendMeetingShareEmail(

                request.inviterUserId(),

                request.inviteeEmail(),

                emailContent

        );

        log.info(

                "event=MEETING_SHARE_PENDING_NOTIFICATION_SENT meetingId={} emailSent={} emailChannel={} role={}",

                request.meetingId(),

                emailResult.sent(),

                emailResult.channel(),

                request.role()

        );

        return emailResult;

    }



    private String meetingTitle(String title, Long meetingId) {

        return StringUtils.hasText(title) ? title.trim() : ("Cuộc họp #" + meetingId);

    }



    private String urlHost(String url) {

        if (!StringUtils.hasText(url)) {

            return "unknown";

        }

        try {

            return java.net.URI.create(url).getHost();

        } catch (RuntimeException ex) {

            return "invalid";

        }

    }



    public record MeetingShareNotificationRequest(

            Long inviteeUserId,

            Long inviterUserId,

            Long meetingId,

            String meetingTitle,

            String role

    ) {

    }



    public record PendingMeetingShareNotificationRequest(

            String inviteeEmail,

            Long inviterUserId,

            Long meetingId,

            String meetingTitle,

            String role

    ) {

    }



    public record MeetingShareNotificationResult(

            UserNotification notification,

            ShareEmailResult emailResult

    ) {

        public static MeetingShareNotificationResult skippedOnly() {

            return new MeetingShareNotificationResult(null, ShareEmailResult.skipped(false, java.util.List.of()));

        }

    }

}

