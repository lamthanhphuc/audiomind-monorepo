-- Semantic embeddings for cross-meeting search (JSONB vectors; pgvector optional later)
CREATE TABLE IF NOT EXISTS meeting_semantic_embeddings (
    meeting_id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    embedding JSONB NOT NULL,
    content_preview TEXT,
    model VARCHAR(64) NOT NULL DEFAULT 'text-embedding-004',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meeting_semantic_embeddings_user ON meeting_semantic_embeddings(user_id);
