-- Roles + plans (lightweight MVP fields on user row)
ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS role VARCHAR(30) NOT NULL DEFAULT 'USER',
    ADD COLUMN IF NOT EXISTS plan VARCHAR(30) NOT NULL DEFAULT 'FREE';

CREATE INDEX IF NOT EXISTS idx_app_users_role ON app_users(role);
CREATE INDEX IF NOT EXISTS idx_app_users_plan ON app_users(plan);

-- Usage counters (monthly buckets, kept in user-service for cost/quota guard)
CREATE TABLE IF NOT EXISTS usage_counters (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    period_yyyymm VARCHAR(6) NOT NULL,
    stt_seconds_used BIGINT NOT NULL DEFAULT 0,
    gemini_input_chars_used BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_usage_counters_user_period
    ON usage_counters(user_id, period_yyyymm);

CREATE INDEX IF NOT EXISTS idx_usage_counters_period
    ON usage_counters(period_yyyymm);

-- Billing invoices backed by PayOS orderCode/paymentLinkId (manual payments supported)
CREATE TABLE IF NOT EXISTS billing_invoices (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    provider VARCHAR(30) NOT NULL DEFAULT 'PAYOS',
    order_code BIGINT NOT NULL,
    payment_link_id VARCHAR(255),
    amount_vnd BIGINT NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'VND',
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    description VARCHAR(255) NOT NULL,
    checkout_url TEXT,
    qr_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    expired_at TIMESTAMPTZ,
    manual_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_billing_invoices_order_code
    ON billing_invoices(order_code);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_user
    ON billing_invoices(user_id);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_status
    ON billing_invoices(status);

-- Store webhook deliveries for audit/reconciliation (metadata only; avoid storing raw secrets)
CREATE TABLE IF NOT EXISTS billing_webhook_events (
    id BIGSERIAL PRIMARY KEY,
    provider VARCHAR(30) NOT NULL DEFAULT 'PAYOS',
    order_code BIGINT,
    payment_link_id VARCHAR(255),
    event_code VARCHAR(50),
    event_desc VARCHAR(255),
    success BOOLEAN,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    signature VARCHAR(255),
    payload_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_order_code
    ON billing_webhook_events(order_code);

