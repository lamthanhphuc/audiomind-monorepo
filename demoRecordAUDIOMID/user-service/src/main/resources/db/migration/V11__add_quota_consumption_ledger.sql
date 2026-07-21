CREATE TABLE quota_consumption (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  quota_type VARCHAR(64) NOT NULL,
  stt_seconds_delta BIGINT NOT NULL DEFAULT 0,
  gemini_chars_delta BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL, -- ALLOWED | DENIED
  period_yyyymm VARCHAR(6) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_quota_consumption_owner_key UNIQUE (owner_user_id, idempotency_key)
);

CREATE INDEX ix_quota_consumption_owner_created ON quota_consumption (owner_user_id, created_at);
