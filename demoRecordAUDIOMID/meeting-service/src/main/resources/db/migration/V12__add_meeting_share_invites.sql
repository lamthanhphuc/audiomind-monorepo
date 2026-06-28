CREATE TABLE IF NOT EXISTS meeting_share_invite (
    id BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT NOT NULL,
    invitee_email VARCHAR(320) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'VIEWER',
    invited_by_user_id BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMP WITHOUT TIME ZONE,
    CONSTRAINT uq_meeting_share_invite_meeting_email UNIQUE (meeting_id, invitee_email)
);

CREATE INDEX IF NOT EXISTS idx_meeting_share_invite_email_status ON meeting_share_invite(invitee_email, status);
CREATE INDEX IF NOT EXISTS idx_meeting_share_invite_meeting_id ON meeting_share_invite(meeting_id);
