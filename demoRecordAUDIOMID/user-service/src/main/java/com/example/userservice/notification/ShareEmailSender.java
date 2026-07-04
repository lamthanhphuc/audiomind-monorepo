package com.example.userservice.notification;



import com.example.userservice.entity.UserAccount;

import com.example.userservice.google.GoogleGrantService;

import com.example.userservice.google.GoogleScopes;

import com.example.userservice.notification.gmail.GmailSendService;

import com.example.userservice.repository.UserAccountRepository;

import java.util.List;

import java.util.Optional;

import lombok.RequiredArgsConstructor;

import lombok.extern.slf4j.Slf4j;

import org.springframework.stereotype.Service;



@Service

@RequiredArgsConstructor

@Slf4j

public class ShareEmailSender {



    private final NotificationProperties notificationProperties;

    private final GoogleGrantService grantService;

    private final GmailSendService gmailSendService;

    private final SmtpShareMailSender smtpShareMailSender;

    private final UserAccountRepository userAccountRepository;



    public ShareEmailResult sendMeetingShareEmail(

            Long inviterUserId,

            String toEmail,

            String subject,

            String body

    ) {

        return sendMeetingShareEmail(

                inviterUserId,

                toEmail,

                new ShareInviteEmailContent(subject, body, null)

        );

    }



    public ShareEmailResult sendMeetingShareEmail(

            Long inviterUserId,

            String toEmail,

            ShareInviteEmailContent content

    ) {

        boolean requiresGmailScope = !grantService.hasScope(inviterUserId, GoogleScopes.GMAIL_SEND);

        List<String> missingScopes = requiresGmailScope

                ? List.of(GoogleScopes.GMAIL_SEND)

                : List.of();



        UserAccount inviter = userAccountRepository.findById(inviterUserId).orElse(null);

        String replyTo = inviter == null ? null : inviter.getEmail();



        if (notificationProperties.isGmailSendEnabled()) {

            Optional<String> messageId = gmailSendService.sendMultipart(

                    inviterUserId,

                    toEmail,

                    content.subject(),

                    content.plainText(),

                    content.htmlBody(),

                    replyTo);

            if (messageId.isPresent()) {
                String emailFrom = grantService.resolveGoogleProviderEmail(inviterUserId).orElse("unknown");

                log.info("event=SHARE_EMAIL_SENT channel=GMAIL userId={} messageId={} emailFrom={} hasHtml={}",

                        inviterUserId,

                        messageId.get(),

                        emailFrom,

                        content.htmlBody() != null && !content.htmlBody().isBlank()

                );

                return ShareEmailResult.sent("GMAIL", false, List.of(), messageId.get());

            }

        }



        boolean smtpSent = smtpShareMailSender.send(

                toEmail,

                content.subject(),

                content.plainText(),

                replyTo);

        if (smtpSent) {

            log.info("event=SHARE_EMAIL_SENT channel=SMTP userId={}", inviterUserId);

            return ShareEmailResult.sent("SMTP", requiresGmailScope, missingScopes, null);

        }



        log.info("event=SHARE_EMAIL_SKIPPED channel=NONE userId={} reason=unavailable", inviterUserId);

        return ShareEmailResult.skipped(requiresGmailScope, missingScopes);

    }

}

