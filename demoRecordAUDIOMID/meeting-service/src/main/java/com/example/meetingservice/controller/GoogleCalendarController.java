package com.example.meetingservice.controller;

import com.example.meetingservice.controller.dto.CreateGoogleCalendarEventRequest;
import com.example.meetingservice.controller.dto.GoogleCalendarStatusResponse;
import com.example.meetingservice.google.GoogleCalendarService;
import com.example.meetingservice.security.UserPrincipal;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/meetings/{meetingId}/google")
public class GoogleCalendarController {
    private final GoogleCalendarService calendarService;

    public GoogleCalendarController(GoogleCalendarService calendarService) {
        this.calendarService = calendarService;
    }

    @PostMapping("/calendar-event")
    public ResponseEntity<GoogleCalendarStatusResponse> create(
            @PathVariable Long meetingId,
            @RequestBody CreateGoogleCalendarEventRequest request,
            Authentication authentication) {
        GoogleCalendarStatusResponse response = calendarService.create(
                meetingId, requirePrincipal(authentication).userId(), request);
        HttpStatus status = "creating".equals(response.creationStatus())
                ? HttpStatus.ACCEPTED
                : HttpStatus.OK;
        return ResponseEntity.status(status).body(response);
    }

    @GetMapping("/status")
    public GoogleCalendarStatusResponse status(
            @PathVariable Long meetingId,
            Authentication authentication) {
        return calendarService.status(meetingId, requirePrincipal(authentication).userId());
    }

    private UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }
}
