CREATE TABLE IF NOT EXISTS meeting (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255),
    audio_path VARCHAR(500),
    owner_user_id BIGINT,
    created_at TIMESTAMP WITHOUT TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_meeting_owner_user_id ON meeting(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_meeting_created_at ON meeting(created_at);
