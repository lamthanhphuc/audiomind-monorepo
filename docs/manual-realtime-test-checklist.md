# Manual Realtime Test Checklist

- Watch `FE-Audiomind` browser console once the meeting starts.
- Watch `processing-service` logs for `AUDIO HASH PROCESSING_IN` and `AUDIO HASH PROCESSING_OUT`.
- Watch `ai-service` logs for `stream_stt_chunk received`, `WEBM_HEADER_CHECK`, `DG CONNECT`, `DG CONNECTED`, `DG RAW EVENT Metadata`, `DG RAW EVENT Results`, and `Parsed Deepgram transcript`.
- Success: first chunk evidence appears in all three services and at least one parsed transcript is emitted.
- Failure: missing `first16hex` / `first4hex`, binary size mismatch, no `DG CONNECTED`, or no parsed transcript after a real manual audio test.