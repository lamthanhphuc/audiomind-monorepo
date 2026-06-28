package com.example.userservice.google;

import java.util.List;

public final class GoogleScopes {
    public static final String OPENID = "openid";
    public static final String EMAIL = "email";
    public static final String PROFILE = "profile";
    public static final String CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
    public static final String GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";

    public static final List<String> IDENTITY = List.of(OPENID, EMAIL, PROFILE);
    public static final List<String> SUPPORTED_ADDITIONAL = List.of(CALENDAR_EVENTS, GMAIL_SEND);

    private GoogleScopes() {
    }
}
