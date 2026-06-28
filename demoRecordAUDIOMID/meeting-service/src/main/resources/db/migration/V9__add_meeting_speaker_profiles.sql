CREATE TABLE IF NOT EXISTS meeting_speaker_profile (
    id BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT NOT NULL,
    speaker_key VARCHAR(120) NOT NULL,
    display_name VARCHAR(200) NOT NULL,
    color VARCHAR(24),
    avatar_url TEXT,
    created_by_user_id BIGINT NOT NULL,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_meeting_speaker_profile UNIQUE (meeting_id, speaker_key)
);

CREATE INDEX IF NOT EXISTS idx_meeting_speaker_profile_meeting_id ON meeting_speaker_profile(meeting_id);
