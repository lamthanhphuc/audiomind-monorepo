-- Standalone Google Calendar events (no Audiomind meeting) share google_calendar_links.
ALTER TABLE google_calendar_links
    ALTER COLUMN meeting_id DROP NOT NULL;

ALTER TABLE google_calendar_links
    DROP CONSTRAINT IF EXISTS google_calendar_links_meeting_id_user_id_key;

CREATE UNIQUE INDEX ux_google_calendar_links_meeting_user
    ON google_calendar_links(meeting_id, user_id)
    WHERE meeting_id IS NOT NULL;

ALTER TABLE google_calendar_links
    ADD COLUMN IF NOT EXISTS standalone_title VARCHAR(500);

ALTER TABLE google_calendar_links
    ADD COLUMN IF NOT EXISTS event_start_at TIMESTAMPTZ;

ALTER TABLE google_calendar_links
    ADD COLUMN IF NOT EXISTS event_end_at TIMESTAMPTZ;

ALTER TABLE google_calendar_links
    ADD COLUMN IF NOT EXISTS event_timezone VARCHAR(100);
