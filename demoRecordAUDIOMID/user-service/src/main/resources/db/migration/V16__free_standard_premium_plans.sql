-- Replace the legacy STUDENT / PRO catalog with the B2C FREE / STANDARD / PREMIUM model.
-- Historical invoice plan_code values remain unchanged for auditability; only the default changes.

UPDATE subscription_plans
SET name = 'Free',
    description = 'Ghi âm, tải file và phân tích AI có giới hạn; có quảng cáo.',
    price_vnd = 0,
    currency = 'VND',
    billing_period = 'MONTHLY',
    advertisement_enabled = TRUE,
    recording_minutes_limit = 10,
    ai_analysis_limit = 50000,
    upload_limit = 5,
    flashcard_limit = 0,
    quiz_limit = 0,
    mindmap_limit = 0,
    export_limit = 0,
    features_json = '{"analysis":true,"mindmap":false,"studyFolders":false,"subjectManagement":false,"studySynthesis":false,"flashcards":false,"quiz":false,"export":false}',
    is_active = TRUE,
    sort_order = 10,
    updated_at = NOW()
WHERE code = 'FREE';

INSERT INTO subscription_plans (
    code, name, description, price_vnd, currency, billing_period,
    advertisement_enabled, recording_minutes_limit, ai_analysis_limit,
    upload_limit, flashcard_limit, quiz_limit, mindmap_limit, export_limit,
    features_json, is_active, sort_order
) VALUES (
    'STANDARD', 'Standard', 'Hạn mức cao hơn, có mindmap và không quảng cáo.',
    79000, 'VND', 'MONTHLY', FALSE, 600, 2000000,
    100, 0, 0, 100, 100,
    '{"analysis":true,"mindmap":true,"studyFolders":false,"subjectManagement":false,"studySynthesis":false,"flashcards":false,"quiz":false,"export":true,"priorityProcessing":true}',
    TRUE, 20
)
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

INSERT INTO subscription_plans (
    code, name, description, price_vnd, currency, billing_period,
    advertisement_enabled, recording_minutes_limit, ai_analysis_limit,
    upload_limit, flashcard_limit, quiz_limit, mindmap_limit, export_limit,
    features_json, is_active, sort_order
) VALUES (
    'PREMIUM', 'Premium', 'Đầy đủ mindmap, quiz, flashcard và công cụ học tập theo môn; không quảng cáo.',
    168000, 'VND', 'MONTHLY', FALSE, 1200, 5000000,
    250, 1000, 1000, 300, 300,
    '{"analysis":true,"mindmap":true,"studyFolders":true,"subjectManagement":true,"studySynthesis":true,"flashcards":true,"quiz":true,"export":true,"priorityProcessing":true,"advancedAi":true}',
    TRUE, 30
)
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

UPDATE app_users
SET plan = 'STANDARD', updated_at = NOW()
WHERE UPPER(plan) IN ('PRO', 'STUDENT');

ALTER TABLE billing_invoices ALTER COLUMN plan_code SET DEFAULT 'STANDARD';

UPDATE advertisements
SET target_plans = 'FREE', updated_at = NOW()
WHERE target_plans IS NULL OR target_plans <> 'FREE';

ALTER TABLE advertisements ALTER COLUMN target_plans SET DEFAULT 'FREE';

DELETE FROM subscription_plans WHERE code IN ('PRO', 'STUDENT');
