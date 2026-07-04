package com.example.meetingservice.google;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "google.integration")
public class GoogleCalendarProperties {
    private String userServiceUrl = "http://user-api:8083";
    private String internalServiceToken = "";
    private String calendarApiBaseUrl = "https://www.googleapis.com/calendar/v3";

    public String getUserServiceUrl() {
        return userServiceUrl;
    }

    public void setUserServiceUrl(String userServiceUrl) {
        this.userServiceUrl = userServiceUrl;
    }

    public String getInternalServiceToken() {
        return internalServiceToken;
    }

    public void setInternalServiceToken(String internalServiceToken) {
        this.internalServiceToken = internalServiceToken;
    }

    public String getCalendarApiBaseUrl() {
        return calendarApiBaseUrl;
    }

    public void setCalendarApiBaseUrl(String calendarApiBaseUrl) {
        this.calendarApiBaseUrl = calendarApiBaseUrl;
    }

    public void requireConfigured() {
        if (userServiceUrl == null || userServiceUrl.isBlank()
                || internalServiceToken == null || internalServiceToken.isBlank()
                || calendarApiBaseUrl == null || calendarApiBaseUrl.isBlank()) {
            throw new GoogleCalendarException(GoogleCalendarError.GOOGLE_INTERNAL_TOKEN_UNAVAILABLE);
        }
    }
}
