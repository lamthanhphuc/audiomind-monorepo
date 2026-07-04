package com.example.userservice.notification.gmail;

import jakarta.mail.Message;
import jakarta.mail.MessagingException;
import jakarta.mail.Session;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeBodyPart;
import jakarta.mail.internet.MimeMessage;
import jakarta.mail.internet.MimeMultipart;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.Date;
import java.util.Properties;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

@Component
public class Rfc822MessageBuilder {

    public String buildBase64UrlRaw(String to, String subject, String body) {
        return buildBase64UrlRaw(null, null, to, subject, body, null, null);
    }

    public String buildBase64UrlRaw(String from, String to, String subject, String body, String replyTo) {
        return buildBase64UrlRaw(from, null, to, subject, body, null, replyTo);
    }

    public String buildBase64UrlRaw(
            String from,
            String fromDisplayName,
            String to,
            String subject,
            String plainBody,
            String replyTo
    ) {
        return buildBase64UrlRaw(from, fromDisplayName, to, subject, plainBody, null, replyTo);
    }

    public String buildBase64UrlRaw(
            String from,
            String fromDisplayName,
            String to,
            String subject,
            String plainBody,
            String htmlBody,
            String replyTo
    ) {
        if (!StringUtils.hasText(to)) {
            throw new IllegalArgumentException("to is required");
        }
        if (!StringUtils.hasText(subject)) {
            throw new IllegalArgumentException("subject is required");
        }
        if (plainBody == null) {
            throw new IllegalArgumentException("plainBody is required");
        }
        if (!StringUtils.hasText(from)) {
            throw new IllegalArgumentException("from is required for Gmail send");
        }
        try {
            Session session = Session.getInstance(new Properties());
            MimeMessage message = new MimeMessage(session);
            String senderName = StringUtils.hasText(fromDisplayName) ? fromDisplayName.trim() : from.trim();
            message.setFrom(new InternetAddress(from.trim(), senderName, "UTF-8"));
            message.setRecipient(Message.RecipientType.TO, new InternetAddress(to.trim()));
            if (StringUtils.hasText(replyTo)) {
                message.setReplyTo(new InternetAddress[] { new InternetAddress(replyTo.trim()) });
            }
            message.setSubject(subject, "UTF-8");
            message.setSentDate(new Date());
            message.setHeader("MIME-Version", "1.0");
            message.setHeader("Content-Language", "vi");
            message.setHeader("Message-ID", "<" + UUID.randomUUID() + "@" + messageIdDomain(from) + ">");

            MimeBodyPart textPart = new MimeBodyPart();
            textPart.setText(plainBody, "UTF-8", "plain");

            if (StringUtils.hasText(htmlBody)) {
                MimeBodyPart htmlPart = new MimeBodyPart();
                htmlPart.setContent(htmlBody, "text/html; charset=UTF-8");
                MimeMultipart alternative = new MimeMultipart("alternative");
                alternative.addBodyPart(textPart);
                alternative.addBodyPart(htmlPart);
                message.setContent(alternative);
            } else {
                message.setText(plainBody, "UTF-8");
            }

            ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
            message.writeTo(outputStream);
            return Base64.getUrlEncoder().withoutPadding().encodeToString(outputStream.toByteArray());
        } catch (MessagingException | IOException ex) {
            throw new IllegalStateException("Failed to build RFC822 message", ex);
        }
    }

    private String messageIdDomain(String fromEmail) {
        int at = fromEmail.indexOf('@');
        if (at > 0 && at < fromEmail.length() - 1) {
            return fromEmail.substring(at + 1).trim().toLowerCase();
        }
        return "gmail.com";
    }
}
