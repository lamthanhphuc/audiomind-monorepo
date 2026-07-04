package com.example.meetingservice.google;

import com.example.meetingservice.entity.GoogleCalendarLink;
import com.example.meetingservice.repository.GoogleCalendarLinkRepository;
import java.time.Instant;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class GoogleCalendarLinkReservationService {
    private final GoogleCalendarLinkRepository repository;

    public GoogleCalendarLinkReservationService(GoogleCalendarLinkRepository repository) {
        this.repository = repository;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public Reservation reserve(Long meetingId, Long userId) {
        GoogleCalendarLink existing = repository.findByMeetingIdAndUserId(meetingId, userId).orElse(null);
        if (existing != null) {
            if ("failed".equals(existing.getCreationStatus())) {
                return new Reservation(resetFailedForRetry(existing.getId()), true);
            }
            return new Reservation(existing, false);
        }
        GoogleCalendarLink link = new GoogleCalendarLink();
        link.setMeetingId(meetingId);
        link.setUserId(userId);
        link.setAudiomindCalendarRequestId(UUID.randomUUID());
        link.setGoogleCalendarId("primary");
        link.setCreationStatus("creating");
        link.setConferenceStatus("pending");
        link.setCreatedAt(Instant.now());
        link.setUpdatedAt(Instant.now());
        return new Reservation(repository.saveAndFlush(link), true);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public GoogleCalendarLink complete(Long linkId, GoogleCalendarClient.CalendarEventResult event) {
        GoogleCalendarLink link = repository.findById(linkId).orElseThrow();
        link.setGoogleCalendarEventId(event.eventId());
        link.setConferenceId(event.conferenceId());
        link.setMeetUri(event.meetUri());
        link.setHangoutLink(event.hangoutLink());
        link.setHtmlLink(event.htmlLink());
        link.setConferenceStatus(event.conferenceStatus());
        link.setCreationStatus("success");
        link.setErrorCode(null);
        link.setUpdatedAt(Instant.now());
        return repository.save(link);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public GoogleCalendarLink pending(Long linkId, GoogleCalendarClient.CalendarEventResult event) {
        GoogleCalendarLink link = repository.findById(linkId).orElseThrow();
        link.setGoogleCalendarEventId(event.eventId());
        link.setConferenceId(event.conferenceId());
        link.setMeetUri(event.meetUri());
        link.setHangoutLink(event.hangoutLink());
        link.setHtmlLink(event.htmlLink());
        link.setConferenceStatus(event.conferenceStatus());
        link.setCreationStatus("creating");
        link.setUpdatedAt(Instant.now());
        return repository.save(link);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public GoogleCalendarLink resetFailedForRetry(Long linkId) {
        GoogleCalendarLink link = repository.findById(linkId).orElseThrow();
        link.setCreationStatus("creating");
        link.setConferenceStatus("pending");
        link.setErrorCode(null);
        link.setGoogleCalendarEventId(null);
        link.setConferenceId(null);
        link.setMeetUri(null);
        link.setHangoutLink(null);
        link.setHtmlLink(null);
        link.setAudiomindCalendarRequestId(UUID.randomUUID());
        link.setUpdatedAt(Instant.now());
        return repository.saveAndFlush(link);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void fail(Long linkId, String errorCode) {
        repository.findById(linkId).ifPresent(link -> {
            link.setCreationStatus("failed");
            link.setErrorCode(errorCode);
            link.setUpdatedAt(Instant.now());
            repository.save(link);
        });
    }

    public record Reservation(GoogleCalendarLink link, boolean created) {
    }
}
