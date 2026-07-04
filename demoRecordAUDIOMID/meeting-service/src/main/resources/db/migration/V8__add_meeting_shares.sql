CREATE TABLE IF NOT EXISTS meeting_share (
    id BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT NOT NULL,
    shared_with_user_id BIGINT NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'VIEWER',
    invited_by_user_id BIGINT NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_meeting_share_meeting_user UNIQUE (meeting_id, shared_with_user_id)
);

CREATE INDEX IF NOT EXISTS idx_meeting_share_meeting_id ON meeting_share(meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_share_shared_with_user_id ON meeting_share(shared_with_user_id);
