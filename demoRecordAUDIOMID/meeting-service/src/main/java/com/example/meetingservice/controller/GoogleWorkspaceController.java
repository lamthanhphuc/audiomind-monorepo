package com.example.meetingservice.controller;

import com.example.meetingservice.controller.dto.CreateStandaloneGoogleCalendarEventRequest;
import com.example.meetingservice.controller.dto.GoogleCalendarMeetingListItem;
import com.example.meetingservice.controller.dto.StandaloneGoogleCalendarResponse;
import com.example.meetingservice.google.GoogleCalendarClient;
import com.example.meetingservice.google.GoogleCalendarService;
import com.example.meetingservice.google.InternalGoogleTokenClient;
import com.example.meetingservice.security.UserPrincipal;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/meetings/google")
public class GoogleWorkspaceController {

    private final InternalGoogleTokenClient tokenClient;
    private final GoogleCalendarClient calendarClient;
    private final GoogleCalendarService calendarService;

    public GoogleWorkspaceController(
            InternalGoogleTokenClient tokenClient,
            GoogleCalendarClient calendarClient,
            GoogleCalendarService calendarService) {
        this.tokenClient = tokenClient;
        this.calendarClient = calendarClient;
        this.calendarService = calendarService;
    }

    @GetMapping("/calendars")
    public JsonNode listCalendars(Authentication authentication) {
        String accessToken = tokenClient.getAccessToken(
                requirePrincipal(authentication).userId(),
                List.of(GoogleCalendarService.CALENDAR_EVENTS_SCOPE));
        return calendarClient.listCalendars(accessToken);
    }

    @GetMapping("/calendar-links")
    public List<GoogleCalendarMeetingListItem> listCalendarLinks(Authentication authentication) {
        return calendarService.listLinkedMeetings(requirePrincipal(authentication).userId());
    }

    @PostMapping("/calendar-event")
    public StandaloneGoogleCalendarResponse createStandaloneCalendarEvent(
            Authentication authentication,
            @RequestBody CreateStandaloneGoogleCalendarEventRequest request) {
        return calendarService.createStandalone(requirePrincipal(authentication).userId(), request);
    }

    @PostMapping("/meet")
    public Map<String, Object> createQuickMeet(
            Authentication authentication,
            @RequestBody(required = false) CreateQuickMeetRequest request) {
        String accessToken = tokenClient.getAccessToken(
                requirePrincipal(authentication).userId(),
                List.of(GoogleCalendarService.CALENDAR_EVENTS_SCOPE));
        GoogleCalendarClient.CalendarEventResult result = calendarClient.createQuickMeet(
                accessToken,
                request == null ? null : request.summary());
        return Map.of(
                "eventId", result.eventId(),
                "meetUri", result.meetUri(),
                "hangoutLink", result.hangoutLink(),
                "conferenceStatus", result.conferenceStatus()
        );
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }

    public record CreateQuickMeetRequest(String summary) {
    }
}
