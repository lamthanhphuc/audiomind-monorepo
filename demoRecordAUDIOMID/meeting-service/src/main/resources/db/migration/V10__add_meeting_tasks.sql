CREATE TABLE IF NOT EXISTS meeting_task (
    id BIGSERIAL PRIMARY KEY,
    meeting_id BIGINT NOT NULL,
    title VARCHAR(500) NOT NULL,
    owner VARCHAR(200),
    deadline VARCHAR(100),
    priority VARCHAR(20) NOT NULL DEFAULT 'medium',
    status VARCHAR(30) NOT NULL DEFAULT 'open',
    source_key VARCHAR(200),
    created_by_user_id BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meeting_task_meeting_id ON meeting_task (meeting_id);
CREATE INDEX IF NOT EXISTS idx_meeting_task_status ON meeting_task (status);
