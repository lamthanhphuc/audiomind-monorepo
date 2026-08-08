CREATE TABLE IF NOT EXISTS subscription_plans (
    id BIGSERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    price_vnd BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(10) NOT NULL DEFAULT 'VND',
    billing_period VARCHAR(30) NOT NULL DEFAULT 'MONTHLY',
    advertisement_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    recording_minutes_limit BIGINT NOT NULL DEFAULT 0,
    ai_analysis_limit BIGINT NOT NULL DEFAULT 0,
    upload_limit BIGINT NOT NULL DEFAULT 0,
    flashcard_limit BIGINT NOT NULL DEFAULT 0,
    quiz_limit BIGINT NOT NULL DEFAULT 0,
    mindmap_limit BIGINT NOT NULL DEFAULT 0,
    export_limit BIGINT NOT NULL DEFAULT 0,
    features_json TEXT NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_subscription_plans_code
    ON subscription_plans(code);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_active_sort
    ON subscription_plans(is_active, sort_order, id);

ALTER TABLE billing_invoices
    ADD COLUMN IF NOT EXISTS plan_code VARCHAR(50);

UPDATE billing_invoices
SET plan_code = 'PRO'
WHERE plan_code IS NULL;

ALTER TABLE billing_invoices
    ALTER COLUMN plan_code SET DEFAULT 'PRO',
    ALTER COLUMN plan_code SET NOT NULL;

INSERT INTO subscription_plans (
    code,
    name,
    description,
    price_vnd,
    currency,
    billing_period,
    advertisement_enabled,
    recording_minutes_limit,
    ai_analysis_limit,
    upload_limit,
    flashcard_limit,
    quiz_limit,
    mindmap_limit,
    export_limit,
    features_json,
    is_active,
    sort_order
) VALUES
    ('FREE', 'Free', 'Dành cho người dùng bắt đầu với quota cơ bản và quảng cáo.', 0, 'VND', 'MONTHLY', TRUE, 10, 50000, 5, 10, 10, 3, 3, '{"basicTranscription":true,"basicAiAnalysis":true}', TRUE, 10),
    ('STUDENT', 'Student', 'Gói sinh viên với hạn mức cao hơn Free, vẫn có quảng cáo.', 39000, 'VND', 'MONTHLY', TRUE, 120, 500000, 30, 100, 100, 20, 20, '{"basicTranscription":true,"basicAiAnalysis":true,"subjectManagement":true,"limitedStudyTools":true}', TRUE, 20),
    ('PRO', 'Pro', 'Gói đầy đủ, không quảng cáo và ưu tiên xử lý.', 79000, 'VND', 'MONTHLY', FALSE, 600, 2000000, 100, 500, 500, 100, 100, '{"basicTranscription":true,"basicAiAnalysis":true,"subjectManagement":true,"fullEducationFeatures":true,"priorityProcessing":true,"advancedAi":true,"pdfExport":true}', TRUE, 30)
ON CONFLICT (code) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    price_vnd = EXCLUDED.price_vnd,
    currency = EXCLUDED.currency,
    billing_period = EXCLUDED.billing_period,
    advertisement_enabled = EXCLUDED.advertisement_enabled,
    recording_minutes_limit = EXCLUDED.recording_minutes_limit,
    ai_analysis_limit = EXCLUDED.ai_analysis_limit,
    upload_limit = EXCLUDED.upload_limit,
    flashcard_limit = EXCLUDED.flashcard_limit,
    quiz_limit = EXCLUDED.quiz_limit,
    mindmap_limit = EXCLUDED.mindmap_limit,
    export_limit = EXCLUDED.export_limit,
    features_json = EXCLUDED.features_json,
    is_active = EXCLUDED.is_active,
    sort_order = EXCLUDED.sort_order,
    updated_at = NOW();

CREATE TABLE IF NOT EXISTS advertisements (
    id BIGSERIAL PRIMARY KEY,
    brand_name VARCHAR(120) NOT NULL,
    title VARCHAR(180) NOT NULL,
    description TEXT,
    media_url TEXT,
    thumbnail_url TEXT,
    target_url TEXT,
    type VARCHAR(40) NOT NULL DEFAULT 'BANNER',
    placement VARCHAR(60) NOT NULL DEFAULT 'DASHBOARD',
    duration_seconds INTEGER,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    target_plans VARCHAR(500) NOT NULL DEFAULT 'FREE,STUDENT',
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advertisements_status_schedule
    ON advertisements(status, start_at, end_at);

CREATE INDEX IF NOT EXISTS idx_advertisements_placement
    ON advertisements(placement);
