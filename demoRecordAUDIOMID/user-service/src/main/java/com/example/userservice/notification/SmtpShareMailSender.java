package com.example.userservice.notification;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.mail.MailException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

@Component
@RequiredArgsConstructor
@Slf4j
public class SmtpShareMailSender {

    private final NotificationProperties notificationProperties;

    @Autowired(required = false)
    private JavaMailSender mailSender;

    public boolean send(String toEmail, String subject, String body, String replyToEmail) {
        if (mailSender == null || !StringUtils.hasText(toEmail)) {
            return false;
        }
        try {
            SimpleMailMessage message = new SimpleMailMessage();
            message.setFrom(notificationProperties.getFromEmail());
            message.setTo(toEmail);
            message.setSubject(subject);
            message.setText(body);
            if (StringUtils.hasText(replyToEmail)) {
                message.setReplyTo(replyToEmail);
            }
            mailSender.send(message);
            return true;
        } catch (MailException ex) {
            log.warn(
                    "event=SHARE_EMAIL_SMTP_FAILED errorCode={}",
                    ex.getClass().getSimpleName()
            );
            return false;
        }
    }
}
