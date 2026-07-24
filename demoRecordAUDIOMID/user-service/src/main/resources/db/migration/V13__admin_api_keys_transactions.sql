CREATE TABLE IF NOT EXISTS user_api_keys (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    name VARCHAR(120) NOT NULL,
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    key_prefix VARCHAR(16) NOT NULL,
    key_suffix VARCHAR(12) NOT NULL,
    scopes VARCHAR(255) NOT NULL DEFAULT 'read',
    created_by BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_api_keys_user
    ON user_api_keys(user_id);

CREATE INDEX IF NOT EXISTS idx_user_api_keys_revoked
    ON user_api_keys(revoked_at);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_created_at
    ON billing_invoices(created_at DESC);
