ALTER TABLE meeting
    ADD COLUMN scheduled_start_at TIMESTAMPTZ,
    ADD COLUMN scheduled_end_at TIMESTAMPTZ,
    ADD COLUMN scheduled_timezone VARCHAR(100);

CREATE INDEX idx_meeting_scheduled_start_at
    ON meeting(scheduled_start_at)
    WHERE deleted_at IS NULL AND status = 'scheduled';
