CREATE TABLE google_calendar_links (
    id BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT NOT NULL REFERENCES meeting(id),
    user_id BIGINT NOT NULL,
    audiomind_calendar_request_id UUID NOT NULL,
    google_calendar_event_id VARCHAR(255),
    google_calendar_id VARCHAR(255) NOT NULL DEFAULT 'primary',
    conference_id VARCHAR(255),
    meet_space_name TEXT,
    meet_uri TEXT,
    hangout_link TEXT,
    conference_status VARCHAR(50) NOT NULL DEFAULT 'pending',
    creation_status VARCHAR(50) NOT NULL DEFAULT 'creating',
    error_code VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(meeting_id, user_id),
    UNIQUE(audiomind_calendar_request_id)
);

CREATE UNIQUE INDEX ux_google_calendar_event_id_present
    ON google_calendar_links(google_calendar_event_id)
    WHERE google_calendar_event_id IS NOT NULL;
