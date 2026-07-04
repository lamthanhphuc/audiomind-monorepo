CREATE TABLE zoom_oauth_grants (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(id),
    zoom_user_id VARCHAR(255) NOT NULL,
    zoom_email VARCHAR(255),
    encrypted_refresh_token TEXT,
    token_iv VARCHAR(255),
    token_kid VARCHAR(100),
    granted_scopes TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX ux_active_zoom_grant_user
    ON zoom_oauth_grants(user_id)
    WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX ux_active_zoom_grant_zoom_user
    ON zoom_oauth_grants(zoom_user_id)
    WHERE revoked_at IS NULL;

CREATE INDEX idx_zoom_oauth_grants_user ON zoom_oauth_grants(user_id);
