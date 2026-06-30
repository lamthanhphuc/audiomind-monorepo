-- Dual-stream STT migration for ai-service Postgres
-- Run once on staging/prod before enabling REALTIME_DUAL_STREAM_TAB_MIC_ENABLED

ALTER TABLE transcript_fragments
  ADD COLUMN IF NOT EXISTS stream_id VARCHAR(8) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS ix_transcript_fragments_meeting_stream_seq
  ON transcript_fragments (meeting_id, stream_id, seq);

ALTER TABLE transcript_checkpoints
  ADD COLUMN IF NOT EXISTS stream_id VARCHAR(8) NOT NULL DEFAULT '';

-- Existing single-stream rows use stream_id=''.
-- For composite PK migration on existing DBs, adjust per deployment:
-- 1. Add stream_id column (done above)
-- 2. Drop old PK on meeting_id only
-- 3. Add PRIMARY KEY (meeting_id, stream_id)
