package com.example.userservice.notification;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "app.notifications")
@Getter
@Setter
public class NotificationProperties {

    private boolean meetingShareEnabled = true;
    private boolean gmailSendEnabled = true;
    private boolean taskReminderEnabled = true;
    private String fromEmail = "noreply@audiomind.local";
    private String frontendBaseUrl = "http://localhost:8080";
    /** Product name shown in HTML share-invite emails. */
    private String brandName = "AudioMind";
    /** Hex accent for CTA/header, e.g. #5b4bff */
    private String brandAccentColor = "#5b4bff";
}
