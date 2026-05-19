# Phase 3 Follow-Up Backlog

## 1. Live preview currently progressive; final transcript is segmented after stop

- Problem: the live preview can look complete before stop, but the persisted final transcript arrives as segmented fragments after hydration.
- Current behavior: the UI streams progressive text while recording and then hydrates post-stop fragments from processing.
- Desired behavior: keep the progressive preview during capture, then render the final transcript as multiple timestamped segments after stop.
- Suggested direction: broadcast segment-level live events with `segment_id`, `start_time`, and `end_time`.
- Priority: Medium

## 2. Add audio RMS and mic diagnostics for `text_len=0` cases

- Problem: some runs produce `speech_started=0` and `text_len=0`, which makes it hard to tell whether the issue is audio capture or STT parsing.
- Current evidence: Deepgram can return empty text even when the pipeline is otherwise healthy.
- Suggested direction: add FE audio-level logging, optional playback or download debug hooks, and more explicit ai-service Deepgram logging.
- Priority: Medium

## 3. Add E2E browser test for realtime transcript

- Problem: the post-stop hydration and final transcript segmentation path is not covered by an end-to-end browser test.
- Suggested flow: login, realtime record, stop, hydrate, verify multiple segments and timestamps.
- Priority: High

## 4. Add monitoring dashboard for STT ownership and finalization

- Problem: ownership conflicts and finalization delays are currently harder to spot than they should be.
- Metrics and logs to track: `STT_LEASE_ACQUIRE`, `STT_LEASE_RENEW`, `STT_LEASE_RELEASE`, `STT_FINALIZATION_END`, `STT_FRAGMENT_VISIBLE_OUTPUT`, ownership conflicts, hydration fragments count.
- Priority: Medium

## 5. Improve speaker label from `system` to user or speaker

- Problem: the UI can display the speaker as `system` even when a real speaker label is available.
- Suggested direction: preserve the real speaker or user label through ai-service, processing-service, and FE DTOs.
- Priority: Low-Medium