ALTER TABLE app_users
    ALTER COLUMN password_hash DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS auth_provider_primary VARCHAR(50) NOT NULL DEFAULT 'local';

CREATE TABLE IF NOT EXISTS user_identities (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    provider_sub VARCHAR(255) NOT NULL,
    provider_email VARCHAR(255),
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    display_name VARCHAR(255),
    avatar_url TEXT,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    unlinked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_active_identity_provider_sub
    ON user_identities(provider, provider_sub)
    WHERE unlinked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_active_identity_user_provider
    ON user_identities(user_id, provider)
    WHERE unlinked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_identities_user
    ON user_identities(user_id);
