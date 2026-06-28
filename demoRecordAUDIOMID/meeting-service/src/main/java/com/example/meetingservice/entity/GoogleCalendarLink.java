package com.example.meetingservice.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.UUID;
import lombok.Getter;
import lombok.Setter;

@Entity
@Table(name = "google_calendar_links")
@Getter
@Setter
public class GoogleCalendarLink {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "meeting_id")
    private Long meetingId;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "audiomind_calendar_request_id", nullable = false)
    private UUID audiomindCalendarRequestId;

    @Column(name = "google_calendar_event_id", length = 255)
    private String googleCalendarEventId;

    @Column(name = "google_calendar_id", nullable = false, length = 255)
    private String googleCalendarId = "primary";

    @Column(name = "conference_id", length = 255)
    private String conferenceId;

    @Column(name = "meet_space_name")
    private String meetSpaceName;

    @Column(name = "meet_uri")
    private String meetUri;

    @Column(name = "hangout_link")
    private String hangoutLink;

    @Column(name = "html_link")
    private String htmlLink;

    @Column(name = "conference_status", nullable = false, length = 50)
    private String conferenceStatus = "pending";

    @Column(name = "creation_status", nullable = false, length = 50)
    private String creationStatus = "creating";

    @Column(name = "error_code", length = 100)
    private String errorCode;

    @Column(name = "standalone_title", length = 500)
    private String standaloneTitle;

    @Column(name = "event_start_at")
    private OffsetDateTime eventStartAt;

    @Column(name = "event_end_at")
    private OffsetDateTime eventEndAt;

    @Column(name = "event_timezone", length = 100)
    private String eventTimezone;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;
}
