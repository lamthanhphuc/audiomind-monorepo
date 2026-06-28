CREATE TABLE google_oauth_grants (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(id),
    google_sub VARCHAR(255) NOT NULL,
    encrypted_refresh_token TEXT,
    token_iv VARCHAR(255),
    token_kid VARCHAR(100),
    granted_scopes TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX ux_active_google_grant_user
    ON google_oauth_grants(user_id)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX ux_active_google_grant_sub
    ON google_oauth_grants(google_sub)
    WHERE revoked_at IS NULL;

CREATE INDEX idx_google_oauth_grants_user ON google_oauth_grants(user_id);
