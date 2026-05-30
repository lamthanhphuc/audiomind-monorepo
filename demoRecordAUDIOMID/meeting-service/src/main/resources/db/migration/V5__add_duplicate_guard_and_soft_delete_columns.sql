ALTER TABLE meeting ADD COLUMN IF NOT EXISTS audio_hash VARCHAR(64);
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS file_size BIGINT;
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE meeting ADD COLUMN IF NOT EXISTS status VARCHAR(32);

UPDATE meeting
SET status = 'processing'
WHERE status IS NULL;

ALTER TABLE meeting
ALTER COLUMN status SET DEFAULT 'processing';

CREATE INDEX IF NOT EXISTS idx_meeting_owner_audio_hash_active
ON meeting(owner_user_id, audio_hash)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_meeting_deleted_at
ON meeting(deleted_at);
