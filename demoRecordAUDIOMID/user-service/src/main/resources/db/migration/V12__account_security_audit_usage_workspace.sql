ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS tokens_valid_after TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS audit_events (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id BIGINT,
    event_type VARCHAR(80) NOT NULL,
    target_type VARCHAR(80),
    target_id VARCHAR(120),
    summary VARCHAR(500) NOT NULL,
    metadata_json TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor_created
    ON audit_events(actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_type_created
    ON audit_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_target
    ON audit_events(target_type, target_id);
