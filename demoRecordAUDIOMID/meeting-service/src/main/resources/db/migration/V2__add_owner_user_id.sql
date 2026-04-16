ALTER TABLE meeting ADD COLUMN IF NOT EXISTS owner_user_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_meeting_owner_user_id ON meeting(owner_user_id);

DO $$ BEGIN
    IF to_regclass('public.app_users') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_meeting_owner_user') THEN
        ALTER TABLE meeting
            ADD CONSTRAINT fk_meeting_owner_user
            FOREIGN KEY (owner_user_id)
            REFERENCES app_users(id);
    END IF;
END $$;
