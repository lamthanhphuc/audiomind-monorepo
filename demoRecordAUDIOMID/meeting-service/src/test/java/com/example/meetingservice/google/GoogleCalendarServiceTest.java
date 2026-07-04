package com.example.meetingservice.google;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.meetingservice.controller.dto.CreateGoogleCalendarEventRequest;
import com.example.meetingservice.controller.dto.CreateStandaloneGoogleCalendarEventRequest;
import com.example.meetingservice.entity.GoogleCalendarLink;
import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.repository.GoogleCalendarLinkRepository;
import com.example.meetingservice.service.MeetingService;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

class GoogleCalendarServiceTest {
    private MeetingService meetingService;
    private GoogleCalendarLinkRepository repository;
    private GoogleCalendarLinkReservationService reservationService;
    private InternalGoogleTokenClient tokenClient;
    private GoogleCalendarClient calendarClient;
    private GoogleCalendarService service;

    @BeforeEach
    void setUp() {
        meetingService = mock(MeetingService.class);
        repository = mock(GoogleCalendarLinkRepository.class);
        reservationService = mock(GoogleCalendarLinkReservationService.class);
        tokenClient = mock(InternalGoogleTokenClient.class);
        calendarClient = mock(GoogleCalendarClient.class);
        service = new GoogleCalendarService(
                meetingService, repository, reservationService, tokenClient, calendarClient);
    }

    @Test
    void existingSuccessfulLinkIsReturnedWithoutAnotherGoogleCall() {
        Meeting meeting = meeting(10L, 9L);
        GoogleCalendarLink link = link(10L, 9L, "success");
        link.setMeetUri("https://meet.google.com/abc-defg-hij");
        when(meetingService.findByIdForOwner(10L, 9L)).thenReturn(meeting);
        when(repository.findByMeetingIdAndUserId(10L, 9L)).thenReturn(Optional.of(link));

        var response = service.create(10L, 9L, validRequest());

        assertThat(response.meetUri()).isEqualTo("https://meet.google.com/abc-defg-hij");
        verify(tokenClient, never()).getAccessToken(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        verify(calendarClient, never()).createEvent(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }

    @Test
    void pendingConferenceReturnsCreatingStatus() {
        GoogleCalendarLink reserved = link(11L, 9L, "creating");
        when(meetingService.findByIdForOwner(11L, 9L)).thenReturn(meeting(11L, 9L));
        when(repository.findByMeetingIdAndUserId(11L, 9L)).thenReturn(Optional.empty());
        when(tokenClient.getAccessToken(9L, List.of(GoogleCalendarService.CALENDAR_EVENTS_SCOPE)))
                .thenReturn("token");
        when(reservationService.reserve(11L, 9L))
                .thenReturn(new GoogleCalendarLinkReservationService.Reservation(reserved, true));
        GoogleCalendarClient.CalendarEventResult pendingEvent = new GoogleCalendarClient.CalendarEventResult(
                "event-1",
                null,
                null,
                null,
                null,
                "pending"
        );
        when(calendarClient.createEvent(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                .thenReturn(pendingEvent);
        GoogleCalendarLink pendingLink = link(11L, 9L, "creating");
        pendingLink.setGoogleCalendarEventId("event-1");
        when(reservationService.pending(1L, pendingEvent)).thenReturn(pendingLink);

        var response = service.create(11L, 9L, validRequest());

        assertThat(response.creationStatus()).isEqualTo("creating");
        assertThat(response.googleCalendarEventId()).isEqualTo("event-1");
    }

    @Test
    void missingScopeDoesNotCreatePlaceholder() {
        when(meetingService.findByIdForOwner(10L, 9L)).thenReturn(meeting(10L, 9L));
        when(repository.findByMeetingIdAndUserId(10L, 9L)).thenReturn(Optional.empty());
        when(tokenClient.getAccessToken(9L, List.of(GoogleCalendarService.CALENDAR_EVENTS_SCOPE)))
                .thenThrow(new GoogleCalendarException(
                        GoogleCalendarError.GOOGLE_SCOPE_MISSING,
                        Map.of("missingScopes", List.of(GoogleCalendarService.CALENDAR_EVENTS_SCOPE))));

        assertThatThrownBy(() -> service.create(10L, 9L, validRequest()))
                .isInstanceOf(GoogleCalendarException.class)
                .extracting(error -> ((GoogleCalendarException) error).error())
                .isEqualTo(GoogleCalendarError.GOOGLE_SCOPE_MISSING);
        verify(reservationService, never()).reserve(10L, 9L);
    }

    @Test
    void concurrentReservationReturnsExistingLinkWithoutDuplicateGoogleCall() {
        GoogleCalendarLink existing = link(12L, 9L, "creating");
        existing.setGoogleCalendarEventId("event-existing");
        when(meetingService.findByIdForOwner(12L, 9L)).thenReturn(meeting(12L, 9L));
        when(repository.findByMeetingIdAndUserId(12L, 9L)).thenReturn(Optional.empty(), Optional.of(existing));
        when(tokenClient.getAccessToken(9L, List.of(GoogleCalendarService.CALENDAR_EVENTS_SCOPE)))
                .thenReturn("token");
        when(reservationService.reserve(12L, 9L))
                .thenThrow(new org.springframework.dao.DataIntegrityViolationException("duplicate"));
        GoogleCalendarClient.CalendarEventResult polled = new GoogleCalendarClient.CalendarEventResult(
                "event-existing",
                null,
                null,
                null,
                null,
                "pending"
        );
        when(calendarClient.getEvent(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.eq("event-existing")))
                .thenReturn(polled);
        when(reservationService.pending(1L, polled)).thenReturn(existing);

        var response = service.create(12L, 9L, validRequest());

        assertThat(response.creationStatus()).isEqualTo("creating");
        verify(calendarClient, never()).createEvent(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }

    @Test
    void standaloneCalendarEventReturnsMeetWithoutMeetingRecord() {
        when(tokenClient.getAccessToken(9L, List.of(GoogleCalendarService.CALENDAR_EVENTS_SCOPE)))
                .thenReturn("token");
        OffsetDateTime start = OffsetDateTime.now().plusHours(1);
        OffsetDateTime end = start.plusHours(1);
        GoogleCalendarClient.CalendarEventResult event = new GoogleCalendarClient.CalendarEventResult(
                "event-standalone",
                "conf-1",
                "https://meet.google.com/abc-defg-hij",
                "https://meet.google.com/abc-defg-hij",
                "https://www.google.com/calendar/event?eid=abc",
                "success"
        );
        when(calendarClient.createEvent(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any()))
                .thenReturn(event);
        when(repository.save(any(GoogleCalendarLink.class))).thenAnswer(invocation -> {
            GoogleCalendarLink link = invocation.getArgument(0);
            link.setId(42L);
            return link;
        });

        var response = service.createStandalone(9L, new CreateStandaloneGoogleCalendarEventRequest(
                "Họp sprint",
                start.toString(),
                end.toString(),
                "Asia/Ho_Chi_Minh",
                List.of()));

        assertThat(response.creationStatus()).isEqualTo("success");
        assertThat(response.meetUri()).isEqualTo("https://meet.google.com/abc-defg-hij");
        assertThat(response.htmlLink()).isEqualTo("https://www.google.com/calendar/event?eid=abc");
        verify(meetingService, never()).findByIdForOwner(org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.anyLong());
        verify(reservationService, never()).reserve(org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.anyLong());
        ArgumentCaptor<GoogleCalendarLink> saved = ArgumentCaptor.forClass(GoogleCalendarLink.class);
        verify(repository).save(saved.capture());
        assertThat(saved.getValue().getMeetingId()).isNull();
        assertThat(saved.getValue().getStandaloneTitle()).isEqualTo("Họp sprint");
        assertThat(saved.getValue().getMeetUri()).isEqualTo("https://meet.google.com/abc-defg-hij");
    }

    @Test
    void listLinkedMeetingsReturnsSuccessfulRowsWithMeetUri() {
        GoogleCalendarLink link = link(7L, 9L, "success");
        link.setMeetUri("https://meet.google.com/abc-defg-hij");
        link.setHtmlLink("https://www.google.com/calendar/event?eid=abc");
        link.setGoogleCalendarEventId("evt-7");
        Meeting meeting = meeting(7L, 9L);
        meeting.setTitle("Họp sprint");
        when(repository.findByUserIdOrderByUpdatedAtDesc(9L)).thenReturn(List.of(link));
        when(meetingService.findByIdForUser(7L, 9L)).thenReturn(meeting);

        var rows = service.listLinkedMeetings(9L);

        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).linkId()).isEqualTo(1L);
        assertThat(rows.get(0).meetingId()).isEqualTo(7L);
        assertThat(rows.get(0).title()).isEqualTo("Họp sprint");
        assertThat(rows.get(0).meetUri()).isEqualTo("https://meet.google.com/abc-defg-hij");
    }

    @Test
    void listLinkedMeetingsReturnsStandaloneRowsWithoutMeeting() {
        GoogleCalendarLink link = link(null, 9L, "success");
        link.setStandaloneTitle("Họp độc lập");
        link.setEventStartAt(OffsetDateTime.parse("2026-06-27T12:00:00+07:00"));
        link.setEventEndAt(OffsetDateTime.parse("2026-06-27T13:00:00+07:00"));
        link.setMeetUri("https://meet.google.com/standalone-meet");
        link.setHtmlLink("https://www.google.com/calendar/event?eid=standalone");
        when(repository.findByUserIdOrderByUpdatedAtDesc(9L)).thenReturn(List.of(link));

        var rows = service.listLinkedMeetings(9L);

        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).linkId()).isEqualTo(1L);
        assertThat(rows.get(0).meetingId()).isNull();
        assertThat(rows.get(0).title()).isEqualTo("Họp độc lập");
        assertThat(rows.get(0).scheduledStartAt()).contains("2026-06-27");
        verify(meetingService, never()).findByIdForUser(org.mockito.ArgumentMatchers.anyLong(), org.mockito.ArgumentMatchers.anyLong());
    }

    private CreateGoogleCalendarEventRequest validRequest() {
        return new CreateGoogleCalendarEventRequest(
                "2026-06-23T10:00:00+07:00",
                "2026-06-23T11:00:00+07:00",
                "Asia/Ho_Chi_Minh",
                List.of("guest@example.com"));
    }

    private Meeting meeting(Long id, Long userId) {
        Meeting meeting = new Meeting();
        meeting.setId(id);
        meeting.setOwnerUserId(userId);
        meeting.setTitle("Weekly sync");
        return meeting;
    }

    private GoogleCalendarLink link(Long meetingId, Long userId, String status) {
        GoogleCalendarLink link = new GoogleCalendarLink();
        link.setId(1L);
        link.setMeetingId(meetingId);
        link.setUserId(userId);
        link.setCreationStatus(status);
        link.setConferenceStatus("success");
        link.setCreatedAt(Instant.now());
        link.setUpdatedAt(Instant.now());
        return link;
    }
}
