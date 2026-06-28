ALTER TABLE app_users
    ADD COLUMN IF NOT EXISTS preferences_json TEXT;
