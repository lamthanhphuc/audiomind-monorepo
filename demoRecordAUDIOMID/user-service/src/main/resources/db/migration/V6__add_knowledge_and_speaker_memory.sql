CREATE TABLE IF NOT EXISTS user_knowledge_note (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(id),
    meeting_id BIGINT,
    term VARCHAR(200),
    note_type VARCHAR(40) NOT NULL DEFAULT 'general',
    title VARCHAR(300),
    body TEXT NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_knowledge_note_user_id ON user_knowledge_note(user_id);
CREATE INDEX IF NOT EXISTS idx_user_knowledge_note_term ON user_knowledge_note(user_id, term);
CREATE INDEX IF NOT EXISTS idx_user_knowledge_note_meeting ON user_knowledge_note(user_id, meeting_id);

CREATE TABLE IF NOT EXISTS user_speaker_memory (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(id),
    speaker_fingerprint VARCHAR(120) NOT NULL,
    display_name VARCHAR(200) NOT NULL,
    usage_count INT NOT NULL DEFAULT 1,
    last_meeting_id BIGINT,
    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_speaker_memory UNIQUE (user_id, speaker_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_user_speaker_memory_user ON user_speaker_memory(user_id);
