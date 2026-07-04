package com.example.meetingservice.google;

import com.example.meetingservice.controller.dto.CreateGoogleCalendarEventRequest;
import com.example.meetingservice.controller.dto.CreateStandaloneGoogleCalendarEventRequest;
import com.example.meetingservice.controller.dto.GoogleCalendarMeetingListItem;
import com.example.meetingservice.controller.dto.GoogleCalendarStatusResponse;
import com.example.meetingservice.controller.dto.StandaloneGoogleCalendarResponse;
import com.example.meetingservice.entity.GoogleCalendarLink;
import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.entity.GoogleCalendarLink;
import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.repository.GoogleCalendarLinkRepository;
import com.example.meetingservice.service.MeetingService;
import java.time.OffsetDateTime;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;

@Service
public class GoogleCalendarService {
    public static final String CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
    private static final Logger log = LoggerFactory.getLogger(GoogleCalendarService.class);
    private static final Pattern EMAIL = Pattern.compile("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
    private static final Pattern PLACEHOLDER_ATTENDEE_DOMAIN =
            Pattern.compile("@(example\\.com|example\\.org|test\\.com)$", Pattern.CASE_INSENSITIVE);

    private final MeetingService meetingService;
    private final GoogleCalendarLinkRepository linkRepository;
    private final GoogleCalendarLinkReservationService reservationService;
    private final InternalGoogleTokenClient tokenClient;
    private final GoogleCalendarClient calendarClient;

    public GoogleCalendarService(
            MeetingService meetingService,
            GoogleCalendarLinkRepository linkRepository,
            GoogleCalendarLinkReservationService reservationService,
            InternalGoogleTokenClient tokenClient,
            GoogleCalendarClient calendarClient) {
        this.meetingService = meetingService;
        this.linkRepository = linkRepository;
        this.reservationService = reservationService;
        this.tokenClient = tokenClient;
        this.calendarClient = calendarClient;
    }

    public GoogleCalendarStatusResponse create(
            Long meetingId,
            Long userId,
            CreateGoogleCalendarEventRequest request) {
        Meeting meeting = meetingService.findByIdForOwner(meetingId, userId);
        ValidatedSchedule schedule = validate(request);
        GoogleCalendarLink current = linkRepository.findByMeetingIdAndUserId(meetingId, userId).orElse(null);
        if (current != null && "success".equals(current.getCreationStatus())) {
            return response(current);
        }
        if (current != null && current.getGoogleCalendarEventId() != null && !"failed".equals(current.getCreationStatus())) {
            return pollExisting(current, userId);
        }
        String accessToken = tokenClient.getAccessToken(userId, List.of(CALENDAR_EVENTS_SCOPE));
        GoogleCalendarLinkReservationService.Reservation reservation;
        try {
            reservation = reservationService.reserve(meetingId, userId);
        } catch (DataIntegrityViolationException ex) {
            GoogleCalendarLink concurrent = linkRepository.findByMeetingIdAndUserId(meetingId, userId)
                    .orElseThrow(() -> ex);
            reservation = new GoogleCalendarLinkReservationService.Reservation(concurrent, false);
        }
        GoogleCalendarLink link = reservation.link();
        if ("success".equals(link.getCreationStatus())) {
            return response(link);
        }
        if (link.getGoogleCalendarEventId() != null) {
            return pollExisting(link, userId);
        }
        boolean staleRetry = link.getUpdatedAt() != null
                && Duration.between(link.getUpdatedAt(), Instant.now()).toSeconds() >= 5;
        if (!reservation.created() && !staleRetry) {
            return response(link);
        }

        try {
            GoogleCalendarClient.CalendarEventResult event = calendarClient.createEvent(
                    accessToken,
                    new GoogleCalendarClient.CalendarEventCommand(
                            meeting.getTitle(),
                            schedule.start().toString(),
                            schedule.end().toString(),
                            schedule.timeZone(),
                            schedule.attendees(),
                            "audiomind-" + link.getAudiomindCalendarRequestId()));
            if (event.eventId() == null) {
                throw new GoogleCalendarException(GoogleCalendarError.GOOGLE_CALENDAR_API_ERROR, true, null);
            }
            if (!"success".equals(event.conferenceStatus()) || event.meetUri() == null) {
                log.info("event=GOOGLE_CALENDAR_CONFERENCE_PENDING traceId={} userId={} meetingId={}",
                        MDC.get("traceId"), userId, meetingId);
                return response(reservationService.pending(link.getId(), event));
            }
            GoogleCalendarLink completed = reservationService.complete(link.getId(), event);
            log.info("event=GOOGLE_CALENDAR_CREATED traceId={} userId={} meetingId={}",
                    MDC.get("traceId"), userId, meetingId);
            return response(completed);
        } catch (GoogleCalendarException ex) {
            if (!ex.retryable()
                    && ex.error() != GoogleCalendarError.GOOGLE_SCOPE_MISSING
                    && ex.error() != GoogleCalendarError.GOOGLE_REFRESH_TOKEN_REVOKED) {
                reservationService.fail(link.getId(), ex.error().name());
            }
            throw ex;
        }
    }

    public List<GoogleCalendarMeetingListItem> listLinkedMeetings(Long userId) {
        return linkRepository.findByUserIdOrderByUpdatedAtDesc(userId).stream()
                .map(link -> toListItem(link, userId))
                .filter(item -> item != null)
                .toList();
    }

    private GoogleCalendarMeetingListItem toListItem(GoogleCalendarLink link, Long userId) {
        if (!"success".equals(link.getCreationStatus()) || link.getMeetUri() == null || link.getMeetUri().isBlank()) {
            return null;
        }
        GoogleCalendarLink refreshed = link;
        if (link.getHtmlLink() == null || link.getHtmlLink().isBlank()) {
            refreshed = refreshHtmlLinkQuiet(link, userId);
        }
        if (link.getMeetingId() == null) {
            return new GoogleCalendarMeetingListItem(
                    refreshed.getId(),
                    null,
                    refreshed.getStandaloneTitle(),
                    refreshed.getEventStartAt() != null ? refreshed.getEventStartAt().toString() : null,
                    refreshed.getEventEndAt() != null ? refreshed.getEventEndAt().toString() : null,
                    refreshed.getCreationStatus(),
                    refreshed.getMeetUri(),
                    refreshed.getHtmlLink());
        }
        Meeting meeting;
        try {
            meeting = meetingService.findByIdForUser(link.getMeetingId(), userId);
        } catch (RuntimeException ex) {
            return null;
        }
        String startAt = meeting.getScheduledStartAt() != null
                ? meeting.getScheduledStartAt().toString()
                : (refreshed.getEventStartAt() != null ? refreshed.getEventStartAt().toString() : null);
        String endAt = meeting.getScheduledEndAt() != null
                ? meeting.getScheduledEndAt().toString()
                : (refreshed.getEventEndAt() != null ? refreshed.getEventEndAt().toString() : null);
        return new GoogleCalendarMeetingListItem(
                refreshed.getId(),
                meeting.getId(),
                meeting.getTitle(),
                startAt,
                endAt,
                refreshed.getCreationStatus(),
                refreshed.getMeetUri(),
                refreshed.getHtmlLink());
    }

    private GoogleCalendarLink refreshHtmlLinkQuiet(GoogleCalendarLink link, Long userId) {
        if (link.getGoogleCalendarEventId() == null) {
            return link;
        }
        try {
            String accessToken = tokenClient.getAccessToken(userId, List.of(CALENDAR_EVENTS_SCOPE));
            GoogleCalendarClient.CalendarEventResult event = calendarClient.getEvent(
                    accessToken, link.getGoogleCalendarEventId());
            if (event.htmlLink() != null && !event.htmlLink().isBlank()) {
                link.setHtmlLink(event.htmlLink());
                link.setUpdatedAt(Instant.now());
                return linkRepository.save(link);
            }
        } catch (RuntimeException ex) {
            log.warn("event=GOOGLE_CALENDAR_HTML_LINK_REFRESH_FAILED linkId={} meetingId={} userId={}",
                    link.getId(), link.getMeetingId(), userId);
        }
        return link;
    }

    public StandaloneGoogleCalendarResponse createStandalone(
            Long userId,
            CreateStandaloneGoogleCalendarEventRequest request) {
        if (request == null || request.title() == null || request.title().isBlank()) {
            throw new IllegalArgumentException("title is required");
        }
        ValidatedSchedule schedule = validate(new CreateGoogleCalendarEventRequest(
                request.startDateTime(),
                request.endDateTime(),
                request.timeZone(),
                request.attendees()));
        if (!schedule.end().isAfter(OffsetDateTime.now())) {
            throw new IllegalArgumentException("Scheduled end time must be in the future");
        }
        String accessToken = tokenClient.getAccessToken(userId, List.of(CALENDAR_EVENTS_SCOPE));
        UUID requestUuid = UUID.randomUUID();
        String requestId = "audiomind-standalone-" + requestUuid;
        GoogleCalendarClient.CalendarEventResult event = calendarClient.createEvent(
                accessToken,
                new GoogleCalendarClient.CalendarEventCommand(
                        request.title().trim(),
                        schedule.start().toString(),
                        schedule.end().toString(),
                        schedule.timeZone(),
                        schedule.attendees(),
                        requestId,
                        false));
        if (event.eventId() == null) {
            throw new GoogleCalendarException(GoogleCalendarError.GOOGLE_CALENDAR_API_ERROR, true, null);
        }
        GoogleCalendarClient.CalendarEventResult resolved = event;
        if (!"success".equals(event.conferenceStatus()) || event.meetUri() == null) {
            resolved = calendarClient.getEvent(accessToken, event.eventId());
        }
        String creationStatus = resolved.meetUri() != null ? "success" : "creating";
        GoogleCalendarLink saved = persistStandaloneLink(
                userId,
                requestUuid,
                request.title().trim(),
                schedule,
                resolved,
                creationStatus);
        log.info("event=GOOGLE_CALENDAR_STANDALONE_CREATED traceId={} userId={} linkId={} eventId={} creationStatus={}",
                MDC.get("traceId"), userId, saved.getId(), resolved.eventId(), creationStatus);
        return new StandaloneGoogleCalendarResponse(
                creationStatus,
                resolved.conferenceStatus(),
                resolved.eventId(),
                resolved.meetUri(),
                resolved.hangoutLink(),
                resolved.htmlLink(),
                null);
    }

    private GoogleCalendarLink persistStandaloneLink(
            Long userId,
            UUID requestUuid,
            String title,
            ValidatedSchedule schedule,
            GoogleCalendarClient.CalendarEventResult event,
            String creationStatus) {
        Instant now = Instant.now();
        GoogleCalendarLink link = new GoogleCalendarLink();
        link.setMeetingId(null);
        link.setUserId(userId);
        link.setAudiomindCalendarRequestId(requestUuid);
        link.setStandaloneTitle(title);
        link.setEventStartAt(schedule.start());
        link.setEventEndAt(schedule.end());
        link.setEventTimezone(schedule.timeZone());
        link.setGoogleCalendarId("primary");
        link.setGoogleCalendarEventId(event.eventId());
        link.setConferenceId(event.conferenceId());
        link.setMeetUri(event.meetUri());
        link.setHangoutLink(event.hangoutLink());
        link.setHtmlLink(event.htmlLink());
        link.setConferenceStatus(event.conferenceStatus());
        link.setCreationStatus(creationStatus);
        link.setCreatedAt(now);
        link.setUpdatedAt(now);
        return linkRepository.save(link);
    }

    public GoogleCalendarStatusResponse status(Long meetingId, Long userId) {
        meetingService.findByIdForUser(meetingId, userId);
        GoogleCalendarLink link = linkRepository.findByMeetingIdAndUserId(meetingId, userId).orElse(null);
        if (link == null) {
            return new GoogleCalendarStatusResponse(
                    meetingId, "not_created", "none", null, null, null, null, null);
        }
        if ("creating".equals(link.getCreationStatus()) && link.getGoogleCalendarEventId() != null) {
            return pollExisting(link, userId);
        }
        if ("success".equals(link.getCreationStatus())
                && link.getGoogleCalendarEventId() != null
                && (link.getHtmlLink() == null || link.getHtmlLink().isBlank())) {
            return refreshHtmlLink(link, userId);
        }
        return response(link);
    }

    private GoogleCalendarStatusResponse refreshHtmlLink(GoogleCalendarLink link, Long userId) {
        GoogleCalendarLink refreshed = refreshHtmlLinkQuiet(link, userId);
        return response(refreshed);
    }

    private GoogleCalendarStatusResponse pollExisting(GoogleCalendarLink link, Long userId) {
        String accessToken = tokenClient.getAccessToken(userId, List.of(CALENDAR_EVENTS_SCOPE));
        GoogleCalendarClient.CalendarEventResult event = calendarClient.getEvent(
                accessToken, link.getGoogleCalendarEventId());
        if ("success".equals(event.conferenceStatus()) && event.meetUri() != null) {
            return response(reservationService.complete(link.getId(), event));
        }
        return response(reservationService.pending(link.getId(), event));
    }

    private ValidatedSchedule validate(CreateGoogleCalendarEventRequest request) {
        if (request == null || request.startDateTime() == null || request.endDateTime() == null) {
            throw new IllegalArgumentException("startDateTime and endDateTime are required");
        }
        try {
            OffsetDateTime start = OffsetDateTime.parse(request.startDateTime());
            OffsetDateTime end = OffsetDateTime.parse(request.endDateTime());
            if (!end.isAfter(start)) {
                throw new IllegalArgumentException("endDateTime must be after startDateTime");
            }
            String timeZone = request.timeZone() == null || request.timeZone().isBlank()
                    ? "Asia/Ho_Chi_Minh"
                    : request.timeZone().trim();
            ZoneId.of(timeZone);
            List<String> attendees = request.attendees() == null ? List.of() : request.attendees().stream()
                    .map(String::trim)
                    .filter(value -> !value.isBlank())
                    .filter(email -> !PLACEHOLDER_ATTENDEE_DOMAIN.matcher(email).find())
                    .distinct()
                    .toList();
            if (attendees.size() > 100 || attendees.stream().anyMatch(email -> !EMAIL.matcher(email).matches())) {
                throw new IllegalArgumentException("Invalid attendee email");
            }
            return new ValidatedSchedule(start, end, timeZone, attendees);
        } catch (DateTimeParseException | java.time.zone.ZoneRulesException ex) {
            throw new IllegalArgumentException("Invalid calendar date, offset, or time zone", ex);
        }
    }

    private GoogleCalendarStatusResponse response(GoogleCalendarLink link) {
        return new GoogleCalendarStatusResponse(
                link.getMeetingId(),
                link.getCreationStatus(),
                link.getConferenceStatus(),
                link.getGoogleCalendarEventId(),
                link.getMeetUri(),
                link.getHangoutLink(),
                link.getHtmlLink(),
                link.getErrorCode());
    }

    private record ValidatedSchedule(
            OffsetDateTime start,
            OffsetDateTime end,
            String timeZone,
            List<String> attendees) {
    }
}
