# Realtime Runtime Remediation Specification

# 1. Document Control

| Field                | Value                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version              | 3.8                                                                                                                                                                                                                                                                          |
| Date                 | 2026-07-01                                                                                                                                                                                                                                                                   |
| Status               | DESIGN READY FOR IMPLEMENTATION                                                                                                                                                                                                                                              |
| Primary scope        | Realtime Mic-only, Tab-only, Legacy Mixed Tab+Mic, and True Dual-stream Tab+Mic across frontend capture, WebSocket transport, processing-service, ai-api STT persistence, transcript hydration, authoritative status reconciliation, and AI analysis polling.                |
| Primary browsers     | Google Chrome and Microsoft Edge on Windows.                                                                                                                                                                                                                                 |
| Source-of-truth rule | Current repository source verified with `rtk` is authoritative. CodeGraph is for call-graph discovery only. Where CodeGraph contains untracked review bundles, stale snapshots, or duplicate symbols, current source verified with `rtk read`, `rtk grep`, or `rtk rg` wins. |
| Demo/release policy  | True Dual-stream Tab+Mic is mandatory for the demo/release path. Legacy Mixed Tab+Mic may remain temporarily only as an explicitly selected compatibility mode.                                                                                                              |

## 1.1 Approved Product Decisions

1. True Dual-stream Tab+Mic is mandatory for demo/release.
2. Legacy Mixed Tab+Mic remains explicit temporary compatibility only.
3. No silent fallback from True Dual-stream to Legacy Mixed.
4. Chrome and Edge on Windows are required support targets.
5. One durable transcript from either source preserves analysis eligibility.
6. Source identity is separate from speaker diarization.
7. Protocol v2 external JSON uses snake_case only.
8. `seq=-1` is internal legacy-adapter-only and invalid externally.
9. One global FIFO queue is mandatory per WebSocket connection.
10. Metadata and binary are an atomic application-dispatch pair.
11. Realtime and analysis statuses remain independent.
12. Duration values are metric values, never metric labels.
13. High-cardinality metric labels are forbidden.
14. Never log transcript text, raw audio, tokens, cookies, API keys, or secrets.
15. `RETRYABLE_FAILED` is intermediate only, never the final user-facing analysis result.
16. Realtime/hydration status versioning and analysis polling versioning are separate domains.
17. Transport silence is not inactivity unless the protocol explicitly defines it that way.

## 1.2 In Scope

* Mic-only runtime reliability.
* Tab-only regression protection.
* True Dual-stream Tab+Mic protocol and lifecycle.
* Legacy Mixed Tab+Mic compatibility and deprecation planning.
* STT finalization and transcript persistence.
* Transcript identity, hydration, ordering, dedupe, and provenance across recording sessions and attempts.
* Authoritative reconciliation, stale-response handling, and status versioning.
* Separate realtime/hydration versioning from analysis polling versioning.
* Analysis status ownership, retry ownership, immutable input snapshots, and error mapping.
* Timeout, cancellation, queue, retry, and backpressure behavior.
* Chrome and Edge smoke tests on Windows.
* Runtime observability, privacy, metrics, release gates, and Definition of Done.

## 1.3 Out of Scope

* Redis or distributed circuit breaker work unless separately approved.
* Full STT engine replacement.
* Promising multi-speaker diarization where the current STT provider has no verified capability.
* Database migration by default.
* Silent fallback from True Dual-stream to Legacy Mixed Tab+Mic.
* Rewriting the entire meeting lifecycle into a new state machine without evidence that the current model cannot represent the required states.
* Automatic re-analysis for late transcript segments after an immutable analysis snapshot has been created.

# 2. Core Design Principles

* Durable transcript outranks weak capture heuristics.
* A non-blank persisted transcript must not be discarded because of a tiny final audio chunk or weak tail heuristic.
* True Dual-stream means separate audio sources.
* Tab and microphone must be captured, transported, persisted, hydrated, rendered, and analyzed with separate source identity.
* A True Dual-stream session must never silently become a blank, `default`, or legacy mixed stream.
* Source identity is not speaker identity.
* `tab` and `mic` are source labels. They must not be converted into `Speaker 1` and `Speaker 2`.
* One stream can save the meeting.
* If Tab fails but Mic has a non-blank durable transcript, analysis remains eligible. The same rule applies when Mic fails and Tab succeeds.
* Every terminal outcome is idempotent.
* Duplicate finalize, reconnect, retry, or late network result must not create duplicate transcript rows, duplicate analysis jobs, or conflicting terminal statuses.
* Status and error code are different.
* Status tells the frontend lifecycle state. Error code tells the cause.
* Realtime/hydration response identity and analysis polling response identity use different version domains.
* Queue wait, connect time, read time, retry wait, and recovery work must fit inside the defined path deadline.
* Legacy compatibility must be explicit.
* Existing legacy `stream_id=""` rows remain readable. `"default"` is only a frontend display fallback and must never be persisted as a new audio source identity.
* Realtime/session status reflects capture, transport, framing, streaming, STT, persistence, and transcript availability.
* Analysis status reflects only AI analysis after a non-blank durable transcript exists and an analysis job lifecycle exists.

# 3. Evidence and Repository Safety

## 3.1 Evidence Classification

| Classification | Meaning                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| CONFIRMED      | Verified in current source or supplied runtime evidence.                           |
| PROBABLE       | Strongly suggested by source or runtime evidence but not proven as the root cause. |
| OPEN QUESTION  | Requires browser, runtime, database, or integration evidence.                      |
| REJECTED       | Investigated and not considered a primary root cause.                              |

## 3.2 Repository Safety Rules

* Use `rtk` to confirm current code paths before implementation.
* Treat CodeGraph as a relationship explorer, not as final source evidence.
* Ignore untracked review bundles, old runtime snapshots, temporary archives, and duplicated symbols when confirming implementation details.
* Do not modify unrelated staged work.
* Do not use destructive Git commands during remediation work.
* Do not create migrations, feature flags, queues, or state-machine layers without evidence and ownership.
* Do not claim tests passed unless test execution evidence exists outside this specification.
* Do not invent repository paths, runtime logs, browser evidence, database tables, or existing APIs.
* When current repository source or an `rtk` verification path is unavailable, retain the affected fact as an `OPEN QUESTION`; do not elevate it to `CONFIRMED`.

## 3.3 Evidence Register

| ID    | Severity | Classification | Finding                                                                                                                                                                                               | Required Handling                                                                        |
| ----- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| ER-01 | Critical | CONFIRMED      | ai-api final transcript persistence can fail when final transcript assembly references an undefined meeting identifier.                                                                               | Fix with authoritative actor meeting ID and add persistence-finalization tests.          |
| ER-02 | High     | CONFIRMED      | Transcript persistence already supports stream identity and checkpoints are stream-scoped.                                                                                                            | Do not create a migration unless consumer audit proves a real provenance gap.            |
| ER-03 | High     | CONFIRMED      | Frontend contains a True Dual-stream recorder path with independent Tab and Mic recorders.                                                                                                            | Use this as the mandatory Tab+Mic demo/release path.                                     |
| ER-04 | High     | CONFIRMED      | Frontend uses separate Tab and Mic sequence counters in dual-stream mode.                                                                                                                             | Define sequence scope per stream and per attempt.                                        |
| ER-05 | High     | CONFIRMED      | processing-service uses one worker queue per realtime session, shared by both streams.                                                                                                                | Preserve global FIFO dispatch while preventing cross-stream sequence comparison.         |
| ER-06 | High     | CONFIRMED      | processing-service has strict dual-stream validation for invalid stream IDs.                                                                                                                          | Preserve strict validation and do not normalize invalid dual IDs to legacy values.       |
| ER-07 | High     | CONFIRMED      | Transcript recovery is bounded and separate from normal transcript retrieval.                                                                                                                         | Preserve bounded recovery and add cancellation and late-result tests.                    |
| ER-08 | Medium   | PROBABLE       | Recovery timeout configuration may exceed intended wall-clock budget if connect and read each receive the full deadline.                                                                              | Enforce true total deadline semantics.                                                   |
| ER-09 | Medium   | PROBABLE       | Normal audio forwarding may still use a long global client timeout.                                                                                                                                   | Add dedicated hot-path timeout budgets.                                                  |
| ER-10 | High     | CONFIRMED      | Analysis polling has a frontend-facing status mapper.                                                                                                                                                 | Maintain one canonical status mapper.                                                    |
| ER-11 | Medium   | PROBABLE       | Frontend may still tolerate older analysis status values.                                                                                                                                             | Keep compatibility during rolling deployment while preserving canonical v2 responses.    |
| ER-12 | High     | CONFIRMED      | Legacy Mixed Tab+Mic path still exists through a single-recorder mixer path.                                                                                                                          | Keep only as explicit compatibility mode.                                                |
| ER-13 | High     | CONFIRMED      | Source prefixing in STT output is not proof of speaker diarization.                                                                                                                                   | Render source labels separately from speaker labels.                                     |
| ER-14 | High     | CONFIRMED      | Existing finalization can use a synthetic `seq=-1` sentinel internally.                                                                                                                               | Protocol v2 must use `stream.stop(final_seq)` externally; `seq=-1` remains adapter-only. |
| ER-15 | High     | CONFIRMED      | Legacy hard-gate mixer can mute Tab audio while Mic is active.                                                                                                                                        | True Dual-stream must not use this mixer behavior.                                       |
| ER-16 | Medium   | OPEN QUESTION  | Export/history/search consumers have not yet been audited for provenance-aware identity.                                                                                                              | Blocks persistence extension decisions, not protocol implementation.                     |
| ER-17 | Medium   | OPEN QUESTION  | Browser lifecycle behavior for mute, unmute, ended, and reconnect needs Chrome and Edge smoke evidence.                                                                                               | Blocks release, not initial implementation.                                              |
| ER-18 | High     | CONFIRMED      | Current realtime analysis polling remains meeting-scoped and does not expose an analysis_request_id/analysis_status_version envelope.                                                                 | Design must add separate analysis polling identity so reconnect does not break polling.  |
| ER-19 | Medium   | OPEN QUESTION  | The current audit has no `rtk`-verified evidence of an explicit WebSocket ping/pong contract, application heartbeat, configurable inactivity threshold, or inactivity terminalization implementation. | Phase 0 must verify or define the transport-activity contract before release.            |

# 4. Current Architecture Trace

## 4.1 Mic-only

```text
Frontend mic capture
  -> realtime audio sender
  -> WebSocket handler
  -> realtime session worker
  -> ai-api STT session
  -> fragment/checkpoint persistence
  -> transcript hydration
  -> authoritative status
  -> analysis polling
```

Mic-only must remain compatible with legacy sessions that omit `stream_id`, while new code must not accidentally route Mic-only through Tab+Mic mixer logic.

## 4.2 Tab-only

```text
Frontend browser tab capture
  -> realtime audio sender
  -> processing-service
  -> ai-api STT session
  -> transcript persistence
  -> hydration
  -> authoritative status
  -> analysis
```

Tab-only must not regress while persistence, timeout, or dual-stream logic is remediated.

## 4.3 Legacy Mixed Tab+Mic

```text
Tab audio + Mic audio
  -> AudioContext mixer / hard-gate path
  -> one mixed MediaStream track
  -> single recorder
  -> source identity collapsed
  -> backend receives one stream
```

This mode may remain temporarily as `TAB_MIC_LEGACY_MIXED`, but it is not acceptable as the demo/release True Dual-stream behavior.

## 4.4 True Dual-stream Tab+Mic

```text
Tab track
  -> Tab MediaRecorder
  -> stream_id=tab
  -> recording_session_id
  -> attempt_id
  -> per-stream sequence
  -> processing-service
  -> ai-api tab actor/session
  -> tab transcript persistence

Mic track
  -> Mic MediaRecorder
  -> stream_id=mic
  -> recording_session_id
  -> attempt_id
  -> per-stream sequence
  -> processing-service
  -> ai-api mic actor/session
  -> mic transcript persistence
```

The frontend may merge only for display ordering. It must not merge source identity, session identity, or attempt provenance.

# 5. Root Cause Analysis

## 5.1 Confirmed Root Causes

| Root Cause                                                                                   | Causal Chain                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Undefined meeting identifier in ai-api final persistence path.                               | Finalization reaches final transcript assembly, references an undefined local meeting ID, actor failure occurs, checkpoint/transcript persistence is incomplete, hydration or analysis fails.                                                                                                             |
| Legacy Mixed Tab+Mic collapses Tab and Mic into one track.                                   | Browser Tab+Mic with legacy path uses mixer/hard-gate behavior, creates one track, loses durable source identity, and cannot produce reliable source-separated transcript.                                                                                                                                |
| Finalization relies on synthetic `seq=-1` internally.                                        | Finalize uses a fake sequence, special-case ordering or validation appears, and true dual-stream stream ordering becomes ambiguous.                                                                                                                                                                       |
| Timeout model may allow wall-clock time to exceed intended deadlines.                        | Connect timeout consumes the full budget, read timeout consumes the full budget again, and recovery runs longer than configured target.                                                                                                                                                                   |
| Attempt-local `seq` reset can collide with meeting-only persistence identities.              | Reconnect starts a new attempt at `seq=1`; meeting/stream-only dedupe, checkpoint, cursor, or transcript identity can collide unless recording session and attempt provenance are retained.                                                                                                               |
| Backend terminal timing anchor can be undefined when terminal control never reaches backend. | Transport failure or dispatch failure can prevent accepted controls; socket-close or inactivity terminalization must still create terminal evidence and a meeting-level terminal anchor.                                                                                                                  |
| Analysis eligibility and analysis execution timing were ambiguous.                           | A durable transcript may exist before every stream has terminal evidence; `T_server_meeting_terminal_anchor` is necessary but insufficient because every expected stream must reach terminal outcome after chunk drain and STT/persistence finalization before cutoff or automatic analysis job creation. |

## 5.2 Contributing Factors

| Factor                                                                     | Impact                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Shared worker queue across streams.                                        | Arrival order can be preserved, but Tab and Mic sequence values cannot be globally compared.                                         |
| Long global HTTP timeout.                                                  | A slow ai-api call can block realtime behavior for too long.                                                                         |
| Hydration retry without authoritative backend failure state.               | Frontend can repeatedly fetch zero fragments without showing the real persistence cause.                                             |
| FE/backend version mismatch.                                               | New FE may attempt dual-stream against an old backend without capability negotiation.                                                |
| Speaker/source confusion.                                                  | UI may imply Mic equals Speaker 2 even when diarization was not performed.                                                           |
| Missing mandatory identity/version envelope.                               | Stale hydration, status, or analysis polling can overwrite current UI state.                                                         |
| Meeting-level anchor previously depended on accepted controls only.        | No-control transport fallback had no defined backend operational timing anchor.                                                      |
| Transport activity and inactivity were not defined as a verified contract. | Audio silence can be mistaken for transport inactivity unless protocol-defined heartbeats or valid application frames are specified. |

## 5.3 Symptoms, Not Root Causes

* `HYDRATION_TIMEOUT_NO_TRANSCRIPT`.
* Repeated analysis polling.
* False pending or 404-like behavior.
* Missing Speaker 2.
* Tab audio disappearing while Mic is active.
* Having to speak into Mic twice before transcript appears.
* Tiny final chunks causing incorrect `FAILED_AUDIO_CAPTURE`.
* `RETRYABLE_FAILED` appearing as if it were a terminal analysis result.
* Stale status, hydration, or analysis responses regressing visible UI state.

# 6. Target Runtime Model

## 6.1 Source Modes

| Source Mode            | Description                                                          | Required Stream IDs                                                        |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `MIC_ONLY`             | Microphone-only recording.                                           | Legacy omitted stream ID allowed; explicit `mic` preferred when supported. |
| `TAB_ONLY`             | Browser-tab-only recording.                                          | Legacy omitted stream ID allowed; explicit `tab` preferred when supported. |
| `TAB_MIC_DUAL`         | Mandatory demo/release Tab+Mic mode using independent audio streams. | `tab` and `mic` are both required identities.                              |
| `TAB_MIC_LEGACY_MIXED` | Temporary explicit compatibility mode using one mixed stream.        | Legacy stream identity only; never automatic fallback.                     |

## 6.2 Canonical Identity Rules

```text
Runtime event / chunk idempotency identity:
meeting_id + recording_session_id + attempt_id + stream_id + seq

Runtime checkpoint / cursor identity:
meeting_id + recording_session_id + attempt_id + stream_id

Durable transcript segment provenance:
meeting_id + recording_session_id + attempt_id + stream_id + segment_id

User-facing display grouping:
meeting_id + recording_session_id + stream_id
```

Rules:

1. `segment_id` is unique only inside one stream and one attempt unless implementation proves stronger uniqueness.
2. Tab and Mic with the same `segment_id` remain different transcript segments.
3. Two attempts with the same `seq` or `segment_id` remain different runtime and durable records.
4. `default` is never sent to backend as an audio stream ID.
5. `default` is never persisted as a replacement for legacy `stream_id=""`.
6. Legacy stored rows with `stream_id=""` remain readable.
7. Legacy rows without `recording_session_id` or `attempt_id` are read-only legacy provenance and are never merged with protocol v2 attempt data.

## 6.3 Lifecycle Targets

* At `T_user_stop`, FE starts the bounded final audio flush and stops initiating new capture work.
* Each started stream sends `stream.stop(final_seq=N)` after the flush barrier.
* A stream that never started sends `stream.unavailable`.
* If terminal control cannot reach backend, bounded socket-close or inactivity terminalization supplies server terminal evidence.
* Backend creates `T_server_meeting_terminal_anchor` when final terminal evidence exists for the last required expected stream.
* Analysis eligibility may become true as soon as any non-blank durable transcript exists.
* Analysis job creation, execution, and analysis_input_cutoff are governed by Section 9.4 Rules 4–7. T_server_meeting_terminal_anchor is necessary but not sufficient; every expected stream must also reach terminal outcome after chunk drain and STT/persistence finalization.
* Durable transcript or explicit terminal transcript result must be available by `T_user_stop + 20 seconds`.
* User-facing analysis must be `SUCCEEDED` or `FAILED` by `T_user_stop + 60 seconds`.

# 7. Wire Protocol Contract

## 7.1 Capability Handshake

Before any audio is accepted, FE and processing-service must agree on protocol and source mode.

`auth.init`:

```json
{
  "type": "auth.init",
  "meeting_id": 456,
  "language": "vi",
  "speaker_mode": "single",
  "source_mode": "TAB_MIC_DUAL",
  "protocol_version": 2,
  "requested_streams": ["tab", "mic"],
  "recording_session_id": 10,
  "attempt_id": 1
}
```

`session.ready`:

```json
{
  "type": "session.ready",
  "meeting_id": 456,
  "authenticated": true,
  "protocol_version": 2,
  "dual_stream_backend_enabled": true,
  "accepted_source_mode": "TAB_MIC_DUAL",
  "expected_streams": ["tab", "mic"],
  "status_contract": "realtime-analysis-v3",
  "recording_session_id": 10,
  "attempt_id": 1
}
```

## 7.2 Capability Rules

* FE must not begin True Dual-stream if backend does not echo protocol version 2 with dual-stream capability.
* FE may show an unsupported message.
* FE may offer explicit Legacy Mixed mode before recording begins.
* FE must not silently downgrade after True Dual-stream has started.
* Backend must preserve Mic-only and Tab-only legacy behavior outside dual mode.
* Strict `tab|mic` validation applies only to a session negotiated as `TAB_MIC_DUAL`.
* A reconnect must perform a fresh handshake.
* Queued chunks from old `recording_session_id` or old `attempt_id` must be rejected.
* Backend must tolerate protocol v1 legacy single-stream and protocol v2 dual-stream during rolling deployment.

## 7.3 Session, Attempt, and Sequence Scope

```text
recording_session_id:
A new identifier for each user-started recording session.

attempt_id:
Starts at 1 for a recording_session_id and increments for every reconnect
or replacement attempt.

seq:
Scoped to:
recording_session_id + attempt_id + stream_id

In protocol v2, seq starts at 1 for each new attempt and stream.
```

Rules:

1. Backend must never compare sequence values across different streams.

2. Backend must never compare sequence values across different attempts.

3. Backend must never compare sequence values across different recording sessions.

4. For a started stream with no accepted audio chunk, initialize:

   ```text
   highest_contiguous_accepted_seq = 0
   ```

5. Finalization correctness uses `highest_contiguous_accepted_seq`, not ambiguous `last_accepted_seq`.

6. A stream can finalize successfully only when:

   ```text
   highest_contiguous_accepted_seq == final_seq
   ```

   or an explicit bounded gap policy reaches a terminal failure.

7. A received higher sequence must not hide an earlier missing sequence.

8. On reconnect:

   * the old attempt becomes `REPLACED` or otherwise non-blocking;
   * old queued chunks and controls are rejected;
   * the new attempt starts fresh per-stream sequence numbering;
   * durable persisted transcript from prior valid attempts remains available under meeting/session/source identity;
   * only the current attempt can block current-attempt finalization;
   * valid durable prior-attempt segments may remain eligible for the later session-level analysis snapshot.

## 7.4 `audio.chunk`

```json
{
  "type": "audio.chunk",
  "meeting_id": 456,
  "source_mode": "TAB_MIC_DUAL",
  "stream_id": "tab",
  "seq": 17,
  "ts_ms": 1782864539135,
  "sample_rate": 48000,
  "channels": 1,
  "encoding": "webm-opus",
  "mime_type": "audio/webm; codecs=opus",
  "size": 12345,
  "recording_session_id": 10,
  "attempt_id": 1
}
```

Rules:

* Audio binary payload must immediately follow valid metadata.
* In True Dual-stream, `stream_id` must be exactly `tab` or `mic`.
* `seq` is a positive integer (`>= 1`) in external protocol v2 audio chunks.
* `seq=0` is invalid for `audio.chunk`; `0` is permitted only as `final_seq` for a started stream that emitted no audio pairs.
* `seq` increases independently per stream and attempt.
* `tab:1` and `mic:1` are both valid.
* `attempt_id=1, tab:1` and `attempt_id=2, tab:1` are both valid and distinct.
* Backend must not compare a Tab sequence against a Mic sequence.
* Backend must not compare one attempt's sequence against another attempt's sequence.
* `seq=-1` is invalid as an external protocol v2 chunk sequence.
* Blank, null, or unknown `stream_id` in `TAB_MIC_DUAL` is a chunk-level `DUAL_STREAM_INVALID` error.
* Invalid dual-stream chunks are rejected and logged without transcript text or raw audio; they do not automatically fail the whole meeting.
* FE must not send audio unless session.ready echoes the same
  recording_session_id and attempt_id accepted for the current connection.
* A mismatch is treated as a failed handshake.

## 7.5 `stream.stop`

`stream.stop` is the protocol v2 terminal control event for a stream that started. It declares the final sequence boundary; it does not itself prove that the stream, transcript, meeting, or analysis has finished.

```json
{
  "type": "stream.stop",
  "meeting_id": 456,
  "stream_id": "tab",
  "final_seq": 42,
  "recording_session_id": 10,
  "attempt_id": 1,
  "terminal_reason": "user_stop"
}
```

Valid `terminal_reason` values:

```text
user_stop
track_ended
capture_timeout
capture_error
reconnect_replaced
```

### 7.5.1 Final Audio Flush Barrier

Rules:

1. At `T_user_stop`, FE marks each stream as locally stopping.
2. FE stops initiating new capture work.
3. FE requests recorder stop/flush.
4. A final `dataavailable` event emitted during bounded flush remains valid.
5. FE enqueues that final metadata-binary pair before sealing `final_seq`.
6. `final_seq` is sealed only after:

   * recorder terminal data/stop event; or
   * bounded final-flush timeout.
7. Final-flush budget is `<= 500 ms`.
8. The flush policy must leave enough time for initial terminal-control dispatch by `T_user_stop + 1 second`.
9. If flush times out:

   * use highest fully enqueued sequence;
   * send `stream.stop` with `terminal_reason="capture_timeout"`;
   * record `FINAL_AUDIO_FLUSH_TIMEOUT` in stream diagnostics.
10. A started stream with no emitted audio pairs uses `final_seq=0`.
11. No new pair may be created after `final_seq` is sealed.

### 7.5.2 `stream.stop` Rules

* `final_seq` is the greatest non-negative sequence emitted and fully enqueued by FE for that stream after the final audio flush barrier.
* `stream.stop` is appended to the global FIFO queue after:

  * every already-enqueued global item; and
  * every audio pair of the same stream through `final_seq`.
* FE must not wait for the entire global queue to drain before enqueuing `stream.stop`.
* An accepted `stream.stop` changes the stream lifecycle to `FINALIZING`; it does not make `terminal_streams[stream_id]=FINALIZED`.
* Backend moves the stream to a terminal result only after:

  1. accepted chunk work through `final_seq` has drained, or a bounded sequence-gap policy resolves the gap; and
  2. STT/persistence finalization has reached a terminal stream outcome.
* If FE claims `final_seq=42` but backend accepts only through `40`, backend must not silently finalize as successful.
* This condition becomes stream-level `STREAM_SEQUENCE_GAP` or timeout and must be observable.
* After accepted `stream.stop(final_seq=N)`, backend rejects subsequently received audio chunk `seq > N` as `POST_TERMINAL_AUDIO_CHUNK`.
* Exact duplicate audio inside the accepted sequence range may deduplicate safely.
* Post-terminal chunk rejection must not erase valid durable transcript.

## 7.6 `stream.unavailable`

Use `stream.unavailable` only when a stream never started and therefore has no valid `final_seq`.

```json
{
  "type": "stream.unavailable",
  "meeting_id": 456,
  "stream_id": "mic",
  "recording_session_id": 10,
  "attempt_id": 1,
  "terminal_reason": "permission_denied"
}
```

Valid `terminal_reason` values:

```text
permission_denied
no_audio_track
unsupported_browser
device_error
capture_initialization_failed
```

Rules:

* `stream.unavailable` is valid only for a stream that never became active and has no pending audio pair.
* It must not be represented as `stream.stop(final_seq=-1)`.
* On acceptance, it may immediately set `terminal_streams[stream_id]=UNAVAILABLE`.
* The acknowledgement must echo `terminal_reason`.
* Any subsequent audio chunk for an accepted unavailable stream is rejected with `POST_TERMINAL_AUDIO_CHUNK`.
* It does not fail the meeting if another expected stream can produce a non-blank durable transcript.

## 7.7 `stream.terminal_ack`

`stream.terminal_ack` is the protocol v2 acknowledgement for a terminal control event. It confirms only that processing-service received, validated, recorded, and accepted or rejected the control at the WebSocket/control layer.

It must never prove:

* transcript durability;
* STT completion;
* stream `FINALIZED`;
* meeting finalization;
* analysis start;
* analysis completion.

### 7.7.1 Terminal ACK Response Format

Accepted `stream.stop`:

```json
{
  "type": "stream.terminal_ack",
  "meeting_id": 456,
  "stream_id": "tab",
  "recording_session_id": 10,
  "attempt_id": 1,
  "control_type": "stream.stop",
  "final_seq": 42,
  "terminal_reason": "user_stop",
  "accepted": true,
  "control_disposition": "ACCEPTED",
  "stream_state": "FINALIZING"
}
```

Accepted `stream.unavailable`:

```json
{
  "type": "stream.terminal_ack",
  "meeting_id": 456,
  "stream_id": "mic",
  "recording_session_id": 10,
  "attempt_id": 1,
  "control_type": "stream.unavailable",
  "terminal_reason": "permission_denied",
  "accepted": true,
  "control_disposition": "ACCEPTED",
  "stream_state": "UNAVAILABLE"
}
```

Idempotent replay of an identical terminal control:

```json
{
  "type": "stream.terminal_ack",
  "meeting_id": 456,
  "stream_id": "tab",
  "recording_session_id": 10,
  "attempt_id": 1,
  "control_type": "stream.stop",
  "final_seq": 42,
  "terminal_reason": "user_stop",
  "accepted": true,
  "control_disposition": "IDEMPOTENT_REPLAY",
  "stream_state": "FINALIZING"
}
```

Rejected conflicting terminal control:

```json
{
  "type": "stream.terminal_ack",
  "meeting_id": 456,
  "stream_id": "tab",
  "recording_session_id": 10,
  "attempt_id": 1,
  "control_type": "stream.stop",
  "final_seq": 43,
  "terminal_reason": "user_stop",
  "accepted": false,
  "control_disposition": "REJECTED",
  "error_code": "TERMINAL_CONTROL_CONFLICT"
}
```

### 7.7.2 Terminal ACK Rules

1. processing-service must return `stream.terminal_ack` for every accepted terminal control and every rejected terminal control that is syntactically parseable.

2. `control_type` identifies the acknowledged control event.

3. For `stream.stop`, `final_seq` must echo the requested `final_seq`.

4. For `stream.unavailable`, `final_seq` is omitted.

5. Every terminal ACK must echo `terminal_reason`.

6. A terminal control is an identical replay only when all of these fields are equal:

   ```text
   meeting_id
   recording_session_id
   attempt_id
   stream_id
   control_type
   final_seq for stream.stop
   terminal_reason
   ```

7. An identical replay returns:

   ```json
   {
     "accepted": true,
     "control_disposition": "IDEMPOTENT_REPLAY"
   }
   ```

8. Incompatible control returns:

   ```json
   {
     "accepted": false,
     "control_disposition": "REJECTED",
     "error_code": "TERMINAL_CONTROL_CONFLICT"
   }
   ```

9. A stale session, stale attempt, or invalid ordering returns `accepted=false`, `control_disposition="REJECTED"`, and `error_code="STALE_TERMINAL_CONTROL"`.

10. Accepted `stream.stop` means `stream_state=FINALIZING` only.

11. `terminal_streams[stream_id]` becomes `FINALIZED` only after contiguous drain or bounded gap result and terminal STT/persistence outcome.

12. Accepted `stream.unavailable` may immediately set `terminal_streams[stream_id]=UNAVAILABLE`.

13. Receipt of an accepted ACK confirms dispatch and control acceptance. FE remains in `FINALIZING` while stream work completes.

14. If no ACK arrives within the ACK waiting window after dispatch, FE follows the stop-ack reconciliation policy.

### 7.7.3 Terminal-Control Error Codes

| Error Code                  | Meaning                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `TERMINAL_CONTROL_CONFLICT` | A terminal control conflicts with an already accepted terminal control for the same stream and attempt.                                 |
| `STALE_TERMINAL_CONTROL`    | The control uses a stale recording session or attempt, or is invalidly ordered.                                                         |
| `POST_TERMINAL_AUDIO_CHUNK` | Audio was received after an accepted terminal boundary: `seq > final_seq` after `stream.stop`, or any audio after `stream.unavailable`. |
| `FINAL_AUDIO_FLUSH_TIMEOUT` | FE could not complete the bounded final recorder flush before sealing `final_seq`.                                                      |

## 7.8 Finalization Event Rules

| Event                                | Stream Rule                                                                                        | Idempotency Key                                                                | Required Result                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal Tab Stop                      | `stream.stop(tab, final_seq=N)`                                                                    | `meeting_id:recording_session_id:attempt_id:tab:stop:N:reason`                 | ACK reports `FINALIZING`; stream becomes `FINALIZED` only after drain and terminal STT/persistence processing.                                        |
| Normal Mic Stop                      | `stream.stop(mic, final_seq=N)`                                                                    | `meeting_id:recording_session_id:attempt_id:mic:stop:N:reason`                 | ACK reports `FINALIZING`; stream becomes `FINALIZED` only after drain and terminal STT/persistence processing.                                        |
| Tab Stops Before Mic                 | Tab control accepted; Mic remains active.                                                          | Tab terminal-control key                                                       | Meeting terminal closure waits for Mic terminal evidence; durable Tab transcript may make analysis eligible once Section 9.4 Rules 4–7 are satisfied. |
| Mic Stops Before Tab                 | Mic control accepted; Tab remains active.                                                          | Mic terminal-control key                                                       | Meeting terminal closure waits for Tab terminal evidence; durable Mic transcript may make analysis eligible once Section 9.4 Rules 4–7 are satisfied. |
| Mic Permission Denied                | `stream.unavailable(mic)`                                                                          | `meeting_id:recording_session_id:attempt_id:mic:unavailable:permission_denied` | Mic becomes `UNAVAILABLE` immediately; Tab may still complete and enable analysis.                                                                    |
| Tab Track Ends                       | `stream.stop(tab, final_seq=N, terminal_reason=track_ended)`                                       | Tab terminal-control key                                                       | Tab enters `FINALIZING`; Mic may continue.                                                                                                            |
| Duplicate Identical Control          | Same control type, same `final_seq` when applicable, and same `terminal_reason`.                   | Same terminal-control key                                                      | Return `IDEMPOTENT_REPLAY`; no duplicate finalization, recovery, transcript, or analysis job.                                                         |
| Conflicting Control                  | Different `final_seq`, different `terminal_reason`, or incompatible control type after acceptance. | Stream attempt key                                                             | Return `TERMINAL_CONTROL_CONFLICT`; first accepted terminal control remains authoritative.                                                            |
| Late Control After Terminal Decision | Final control arrives after a terminal stream decision has won.                                    | Stream terminal-decision key                                                   | Log and ignore only when exact replay; otherwise reject as `TERMINAL_CONTROL_CONFLICT` or `STALE_TERMINAL_CONTROL`.                                   |
| Reconnect                            | New attempt ID.                                                                                    | Attempt-specific key                                                           | Old queued chunks and controls are rejected or safely ignored with structured diagnostics.                                                            |
| Gap Before Final                     | `highest_contiguous_accepted_seq < final_seq` after bounded drain policy.                          | Stream sequence state                                                          | Stream resolves as `FAILED` or `TIMED_OUT`; never silent success.                                                                                     |

An accepted `stream.stop` does not by itself satisfy the meeting-level `expected_streams` terminal rule. It represents a stream that is finalizing, not a stream already finalized.

## 7.9 Connection-Level Audio Framing Contract

### 7.9.1 Global FIFO Outbound Queue

* Each WebSocket connection has one global FIFO outbound queue.
* An `audio.chunk` metadata object and its matching binary payload are one atomic pair at the application dispatch boundary.
* The queue dispatches metadata and binary consecutively in one dequeue operation.
* `Sent` means handed to `WebSocket.send` in FIFO order. It does not mean network-delivered or server-acknowledged.
* Server framing validation and `stream.terminal_ack` remain authoritative.
* `stream.stop` may be appended only after:

  * all already-enqueued global items; and
  * all audio pairs for its own stream through sealed `final_seq` have been enqueued.
* `stream.unavailable` may be appended only when its stream never started and has no pending audio pair. It still remains behind all previously enqueued global items.
* No terminal control may overtake an audio pair from Tab, Mic, or a legacy stream.
* No control, metadata object, or binary payload may interleave inside an audio metadata-binary pair.
* Chunks and controls from an old `recording_session_id`, `attempt_id`, or WebSocket session must be rejected or safely ignored with structured diagnostics.

### 7.9.2 Atomic Pair Requirement

FE must use one connection-level outbound queue. Each pair is queued and dispatched in exactly this order:

1. metadata JSON;
2. matching binary payload.

FE must not dispatch metadata for the next pair until the previous pair has been dispatched as a complete metadata-binary pair, expired, rejected, or dropped under an explicit policy.

Interleaving is forbidden:

```text
metadata Tab
metadata Mic
binary Tab
binary Mic
```

The backend maintains at most one pending metadata record per WebSocket connection.

The backend rejects `AUDIO_FRAME_PROTOCOL_VIOLATION` when:

* binary arrives without pending metadata;
* new metadata arrives before binary for the pending pair;
* a terminal control appears between pending metadata and binary;
* binary violates size, MIME, identity, or stream validation;
* metadata and binary do not match; or
* a finalized connection sends stale audio.

### 7.9.3 Stop Dispatch Rules

1. At `T_user_stop`, FE stops initiating new capture work and executes the final audio flush barrier.

2. FE must dispatch each initial terminal control to `WebSocket.send` through the global FIFO queue by:

   ```text
   T_user_stop + 1 second
   ```

3. FE must never bypass FIFO to meet this deadline.

4. Initial ACK deadline is:

   ```text
   T_control_dispatch + 3 seconds
   ```

5. A terminal control that was never dispatched must never be labelled `STOP_ACK_TIMEOUT`.

6. On first missing ACK:

   * FE remains `FINALIZING`;
   * FE appends exactly one identical replay behind all already queued global items;
   * replay remains subject to FIFO;
   * replay must be dispatched within `1 second` after first ACK timeout.

7. Retry ACK deadline is:

   ```text
   T_retry_dispatch + 3 seconds
   ```

8. If replay cannot be dispatched within its `1-second` dispatch window:

   * enter `STOP_ACK_RECONCILING`;
   * `error_code=STOP_CONTROL_DISPATCH_TIMEOUT`;
   * `remaining_control_retries=0`.

9. If replay dispatches but second ACK is missing:

   * enter `STOP_ACK_RECONCILING`;
   * `error_code=STOP_ACK_TIMEOUT`;
   * `remaining_control_retries=0`.

### 7.9.4 Dispatch Failure with No Control Received by Backend

When a control cannot be dispatched, FE:

* stops accepting further chunks;
* does not bypass FIFO;
* closes or abandons the affected WebSocket attempt under an explicit safe policy;
* does not allow unsent queued terminal controls to later create ambiguous lifecycle state.

processing-service must have a bounded socket-close/inactivity terminalization path.

If terminal control was never accepted because the socket closed or transport failed:

* backend resolves affected stream as `TIMED_OUT` or `FAILED` under a bounded policy;
* use dedicated stream diagnostic/error `STREAM_TRANSPORT_TIMEOUT`;
* this outcome must fit inside transcript/reconciliation SLA.

This server-side fallback must make reconciliation meaningful even when no `stream.stop` reached backend.

#### Transport Activity and Inactivity Contract

Before implementation exits Phase 0, the service must define either a heartbeat contract or a maximum transport-activity contract.

The configured inactivity terminalization threshold must be documented, configurable, tested, and compatible with the `T_user_stop + 20 seconds` transcript SLA.

Audio silence alone must not count as transport inactivity unless explicitly defined by the protocol.

Valid transport activity consists only of protocol-defined heartbeat traffic or valid WebSocket application frames.

When the configured inactivity threshold expires without valid transport activity, processing-service must begin bounded socket-close/inactivity terminalization and expose `STREAM_TRANSPORT_TIMEOUT` where applicable.

Until Phase 0 produces `rtk`-verified source evidence or an approved protocol decision, no numeric inactivity threshold, ping/pong behavior, application heartbeat behavior, or timeout configuration is assumed by this specification.

### 7.9.5 Framing Error Handling

* Every framing violation produces `AUDIO_FRAME_PROTOCOL_VIOLATION`.
* `AUDIO_FRAME_PROTOCOL_VIOLATION` and `POST_TERMINAL_AUDIO_CHUNK` are chunk-level errors.
* Chunk-level errors do not fail a meeting when another stream can still produce, or already has, a non-blank durable transcript.
* The atomic pair must preserve:

  * `meeting_id`;
  * `recording_session_id`;
  * `attempt_id`;
  * `stream_id`;
  * `seq`.

### 7.9.6 Valid Global FIFO Example

```text
1. tab metadata seq=7
2. tab binary seq=7
3. mic metadata seq=4
4. mic binary seq=4
5. tab stream.stop final_seq=7
6. mic stream.stop final_seq=4
```

### 7.9.7 Invalid Global FIFO Example

```text
1. tab metadata seq=7
2. tab stream.stop final_seq=7
3. tab binary seq=7
```

This example is rejected as `AUDIO_FRAME_PROTOCOL_VIOLATION` because a control event appears between metadata and binary.

## 7.10 Protocol Version Compatibility

### 7.10.1 General Policy

* Protocol v2 external WebSocket JSON uses snake_case for all external fields.
* Protocol v1 compatibility parsing may accept legacy camelCase payloads only at the backend compatibility boundary.
* All accepted protocol v1 payloads must be normalized internally into the canonical protocol v2 snake_case model before validation, lifecycle handling, persistence, status mapping, or downstream forwarding.
* A `protocol_version=2` session must reject:

  * camelCase-only payloads;
  * mixed camelCase and snake_case aliases for the same logical field;
  * ambiguous duplicate fields.

### 7.10.2 Rules

* Legacy protocol v1 compatibility remains limited to legacy single-stream paths unless dual capability is explicitly negotiated.
* Protocol v2 dual-stream requires strict snake_case fields in all outgoing and incoming WebSocket messages.
* Internal Java, TypeScript, or Python identifiers may remain as-is; the snake_case requirement applies only to wire-level JSON field names.
* The handshake parser may temporarily inspect legacy aliases only to determine `protocol_version` for an uninitialized connection.
* After `protocol_version` is resolved:

  * protocol v1 payloads are normalized into canonical snake_case internally;
  * protocol v2 rejects camelCase-only fields;
  * protocol v2 rejects mixed aliases for one logical field;
  * protocol v2 rejects duplicate ambiguous aliases.

### 7.10.3 Rollout Impact

* During rolling deployment, processing-service must serve both v1 and v2 sessions.
* The backend must not reject v1 sessions because of missing snake_case fields.
* v1 sessions that are upgraded to v2 through reconnect must use v2 field naming from that point onward.

### 7.10.4 Protocol Errors

| Error Code                      | Meaning                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `PROTOCOL_FIELD_CASE_INVALID`   | A protocol v2 field uses camelCase instead of snake_case. |
| `PROTOCOL_FIELD_ALIAS_CONFLICT` | Mixed aliases for the same logical field.                 |

# 8. Canonical Stream Lifecycle Model

## 8.1 Stream Sets and Diagnostics

Every session must maintain separate stream structures:

```text
expected_streams:
- Snapshot at negotiated start.
- Example: [tab, mic].
- Includes requested streams even if one later becomes unavailable.

active_streams:
- Streams currently allowed to send audio.
- Changes after permission failure, track ended, user stop, timeout, or reconnect.

terminal_streams:
- Map:
  tab -> FINALIZED | UNAVAILABLE | FAILED | TIMED_OUT | REPLACED
  mic -> FINALIZED | UNAVAILABLE | FAILED | TIMED_OUT | REPLACED
```

`stream_diagnostics` is a separate per-stream reporting structure. It may expose a non-terminal lifecycle state such as `RECORDING`, `FINALIZING`, or `STOP_ACK_RECONCILING`, plus an optional `error_code`, without changing the meeting-level outcome.

## 8.2 Server Terminal Timing Anchors

Define:

```text
T_server_control_accepted(stream_id):
Timestamp when processing-service accepts a terminal control for one stream.

T_server_transport_terminalized(stream_id):
Timestamp when processing-service reaches bounded socket-close/inactivity
terminalization for a stream whose terminal control was never accepted.

T_server_meeting_terminal_anchor:
The timestamp when processing-service has final terminal evidence for the
last required expected stream in the current recording session and attempt.

For each expected stream, terminal evidence is either:
- accepted stream.stop;
- accepted stream.unavailable; or
- bounded socket-close/inactivity terminalization.
```

Rules:

1. `T_server_meeting_terminal_anchor` is meeting-level.
2. It must exist for normal terminal controls and no-control transport fallback.
3. Backend transcript and analysis operational measurements use this anchor.
4. `T_server_control_accepted(stream_id)` remains stream-level telemetry only.
5. `T_server_transport_terminalized(stream_id)` remains stream-level telemetry only.
6. The server terminal anchor never replaces frontend `T_user_stop` SLA.
7. `stream.unavailable` counts as terminal evidence for expected streams.
8. A single stream's accepted timestamp must not be used as the meeting-level timing anchor unless it is also the final required expected stream to produce terminal evidence.
9. `T_server_meeting_terminal_anchor` is necessary but does not itself prove that every expected stream has reached terminal outcome after chunk drain and STT/persistence finalization.

## 8.3 Meeting Terminal Closure and Analysis Eligibility

Meeting terminal closure occurs only when:

* every `expected_streams` entry has reached a terminal stream state;
* all accepted chunk work has drained or timed out under policy;
* transcript persistence/recovery has completed or reached its deadline; and
* `T_server_meeting_terminal_anchor` exists.

`active_streams` alone must never determine meeting closure.

Analysis eligibility is independent of meeting terminal closure:

```text
analysis_eligible =
has_non_blank_durable_transcript_from_any_stream
```

Rules:

* `analysis_eligible=true` as soon as at least one stream has a non-blank durable transcript.
* A durable transcript from one stream must not lose eligibility because another stream is finalizing, reconciling, unavailable, failed, timed out, or replaced.
* When transcript availability is reported as `TRANSCRIPT_READY` while another stream has not reached terminal closure, the response must include `meeting_finalization_pending=true` and relevant `stream_diagnostics`.
* Analysis job creation, execution, and analysis_input_cutoff are governed by Section 9.4 Rules 4–7. T_server_meeting_terminal_anchor is necessary but not sufficient; every expected stream must also reach terminal outcome after chunk drain and STT/persistence finalization.
* A failed, unavailable, timed-out, or replaced stream must reach bounded terminal state and must not block analysis beyond the transcript SLA.

## 8.4 Outcome Rules

| Condition                                                                                                      | Meeting Outcome                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Tab finalizes with durable transcript; Mic unavailable.                                                        | `TRANSCRIPT_READY`; analysis is eligible, while job creation, execution, and cutoff follow Section 9.4 Rules 4–7.                          |
| Mic finalizes with durable transcript; Tab ends or fails.                                                      | `TRANSCRIPT_READY`; analysis is eligible, while job creation, execution, and cutoff follow Section 9.4 Rules 4–7.                          |
| Tab and Mic both produce durable transcript.                                                                   | Merge for display while preserving source and attempt identity; analysis uses the immutable snapshot contract after Section 9.4 Rules 4–7. |
| One stream has durable transcript while another is finalizing or reconciling.                                  | `analysis_eligible=true`; report `meeting_finalization_pending=true`; job creation, execution, and cutoff follow Section 9.4 Rules 4–7.    |
| One stream has persistence/capture failure, another has durable transcript.                                    | Do not fail meeting globally; retain stream diagnostic; job creation, execution, and cutoff follow Section 9.4 Rules 4–7.                  |
| All expected streams are terminal, server state is known, and no non-blank durable transcript exists.          | `TRANSCRIPT_TERMINAL_FAILED` with proven error code.                                                                                       |
| Authoritative server state cannot be obtained before reconciliation deadline.                                  | `SESSION_TERMINAL_FAILED`; no analysis input cutoff or analysis job is created.                                                            |
| Terminal control never reaches backend but socket-close/inactivity fallback terminalizes all expected streams. | Use known server state; do not use `SESSION_TERMINAL_FAILED` merely because control was not received.                                      |

# 9. Failure Ownership, Status, and Error Contract

## 9.1 Ownership Matrix

| State/Event             | Owner                                           | FE Responsibility                                                        |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| Capture accepted        | FE + processing-service                         | FE sends valid data; processing-service validates and acknowledges.      |
| Chunk rejected          | processing-service                              | FE renders structured warning/error without inventing a root cause.      |
| STT processing          | ai-api STT actor                                | Actor owns adapter state, queue pressure, and persistence progress.      |
| Transcript persisted    | ai-api persistence                              | Durable rows/checkpoint are the source of truth.                         |
| Transcript unavailable  | ai-api truth surfaced by processing-service     | FE displays explicit transcript terminal state.                          |
| Stream timeout/gap      | processing-service or ai-api, depending on path | FE receives stream and meeting status through canonical contract.        |
| Analysis status         | processing-service                              | FE renders canonical status values only.                                 |
| Analysis provider retry | analysis owner                                  | FE receives retry metadata and polls; it does not submit duplicate jobs. |

## 9.2 Realtime Status Model

| Realtime Status              | Meaning                                                                                                                                   | Terminal                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `CONNECTING`                 | WebSocket connecting or handshake in progress.                                                                                            | No                                                                           |
| `RECORDING`                  | Capture active; audio chunks flowing.                                                                                                     | No                                                                           |
| `FINALIZING`                 | Terminal controls accepted or pending; queue drain, STT finalization, or persistence remains.                                             | No                                                                           |
| `STOP_ACK_RECONCILING`       | A dispatched control missed bounded ACK retries, or a control could not be dispatched; FE is reconciling with authoritative server state. | No                                                                           |
| `TRANSCRIPT_PENDING`         | No durable transcript is available yet; final STT/persistence/recovery work remains.                                                      | No                                                                           |
| `TRANSCRIPT_READY`           | At least one non-blank durable transcript exists. Analysis is eligible. `meeting_finalization_pending` may still be true.                 | Terminal for transcript availability; not necessarily for all-stream closure |
| `TRANSCRIPT_TERMINAL_FAILED` | Server state is known, all expected streams are terminal, and no non-blank durable transcript exists.                                     | Yes                                                                          |
| `SESSION_TERMINAL_FAILED`    | FE cannot obtain authoritative server session or terminal state before reconciliation deadline.                                           | Yes                                                                          |

## 9.3 Analysis Status Model

| Analysis Status    | Meaning                                                                                              | Terminal |
| ------------------ | ---------------------------------------------------------------------------------------------------- | -------- |
| `NOT_STARTED`      | Analysis has not been queued yet. It may coexist with `analysis_eligible=true`.                      | No       |
| `PENDING`          | Analysis job exists and is queued or waiting.                                                        | No       |
| `RUNNING`          | Analysis is active.                                                                                  | No       |
| `SUCCEEDED`        | Analysis completed.                                                                                  | Yes      |
| `RETRYABLE_FAILED` | Provider/analysis execution failed but a server-owned retry remains within all applicable deadlines. | No       |
| `FAILED`           | Analysis is permanently failed or retry budget/deadline is exhausted.                                | Yes      |

## 9.4 Analysis Eligibility, Job Creation, and Blocking Rules

```text
analysis_eligible =
has_non_blank_durable_transcript_from_any_stream
```

Rules:

1. `analysis_eligible` is evaluated at meeting level, not failed-stream level.

2. If any stream has a non-blank durable transcript:

   * `analysis_eligible=true`;
   * `realtime_status=TRANSCRIPT_READY`;
   * `analysis_status=NOT_STARTED` until an analysis job is queued;
   * failed, unavailable, finalizing, reconciling, timed-out, or replaced streams remain only in `stream_diagnostics`.

3. Analysis eligibility and analysis execution are different:

   * transcript exists means eligible;
   * `T_server_meeting_terminal_anchor` is necessary but not sufficient for job creation, execution, or cutoff.

4. Analysis job creation, execution, and `analysis_input_cutoff` require both:

   1. `T_server_meeting_terminal_anchor` exists; and
   2. every expected stream has reached terminal stream outcome after:

      * accepted chunk work drained or timed out under policy; and
      * STT/persistence finalization reached terminal outcome.

5. Accepted `stream.stop` alone is not sufficient because accepted audio may still be draining and STT/persistence may still produce durable transcript segments.

6. When the transcript deadline is reached before every expected stream has a terminal stream outcome, authoritative reconciliation must resolve each unresolved stream to one of `FINALIZED`, `UNAVAILABLE`, `FAILED`, `TIMED_OUT`, or `REPLACED`.

   * If authoritative state cannot be obtained by the reconciliation deadline:

     * `realtime_status=SESSION_TERMINAL_FAILED`;
     * no `analysis_input_cutoff` is created; and
     * no analysis job is created.

7. Only after Rules 4–6 are satisfied:

   * verify that no active automatic analysis job already exists for the same `meeting_id + recording_session_id`;
   * if no active automatic job exists, create exactly one `analysis_request_id` atomically with:

     * one immutable `analysis_input_cutoff`;
     * one immutable analysis input snapshot; and
     * the analysis job state;
   * queue only that one automatic analysis job.

8. The snapshot includes only non-blank durable transcript segments available at `analysis_input_cutoff`.

## 9.5 Internal Status Mapping

1. `QUEUED` maps to `PENDING` only when an analysis job exists.

2. `NOT_READY` maps to `PENDING` only when:

   * `analysis_eligible=true`; and
   * `analysis_job_created=true`.

3. If transcript is not durable yet:

   ```text
   analysis_status = NOT_STARTED
   analysis_eligible = false
   analysis_blocked_reason = TRANSCRIPT_PENDING
   ```

4. Existing meeting with no analysis row:

   ```text
   analysis_status = NOT_STARTED
   ```

5. Missing meeting remains a real not-found result, not `NOT_STARTED`.

## 9.6 Terminal Status Definitions

```text
SESSION_TERMINAL_FAILED:
The FE cannot obtain authoritative server session/terminal state by the
reconciliation deadline.

TRANSCRIPT_TERMINAL_FAILED:
Server state is known, all expected streams are terminal, and no stream has
a non-blank durable transcript.
```

Rules:

1. `FAILED_AUDIO_CAPTURE`, `NO_SPEECH_DETECTED`, `STT_TIMEOUT`, `STT_PERSISTENCE_FAILED`, `STREAM_SEQUENCE_GAP`, `STREAM_TRANSPORT_TIMEOUT`, and `TRANSCRIPT_UNAVAILABLE` are `error_code` values.
2. These errors produce `TRANSCRIPT_TERMINAL_FAILED` only when:

   * server state is known;
   * all expected streams are terminal;
   * no durable transcript exists from any stream.
3. They must not be described as realtime status values.
4. `SESSION_TERMINAL_FAILED` is never used merely because a capture, transport, persistence, or STT error occurred.

## 9.7 Error Code Classification

### 9.7.1 Realtime and Stream Errors

| Error Code                       | Realtime Status Without Any Durable Transcript                                                                                | Realtime Status When Any Durable Transcript Exists | Analysis Eligibility                             | Final Effect                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `AUDIO_FRAME_PROTOCOL_VIOLATION` | `RECORDING` or `FINALIZING`                                                                                                   | `TRANSCRIPT_READY`                                 | Depends on transcript evidence                   | Chunk-level rejection; valid chunks may still produce transcript.                        |
| `POST_TERMINAL_AUDIO_CHUNK`      | Current realtime state                                                                                                        | `TRANSCRIPT_READY`                                 | Depends on transcript evidence                   | Reject only invalid chunk; do not alter valid transcript.                                |
| `STALE_TERMINAL_CONTROL`         | `FINALIZING`                                                                                                                  | `TRANSCRIPT_READY`                                 | Depends on transcript evidence                   | Ignore/reject stale control; existing state remains authoritative.                       |
| `TERMINAL_CONTROL_CONFLICT`      | `FINALIZING`                                                                                                                  | `TRANSCRIPT_READY`                                 | Depends on transcript evidence                   | Reject conflicting control; original accepted control remains authoritative.             |
| `FINAL_AUDIO_FLUSH_TIMEOUT`      | `FINALIZING` or `TRANSCRIPT_PENDING`                                                                                          | `TRANSCRIPT_READY`                                 | Depends on transcript evidence                   | Stream uses bounded final sequence with `capture_timeout`; no automatic meeting failure. |
| `STREAM_SEQUENCE_GAP`            | `FINALIZING`, then `TRANSCRIPT_TERMINAL_FAILED` only if server state is known, all streams terminal, and no transcript exists | `TRANSCRIPT_READY`                                 | False only with no durable transcript            | Stream ends `FAILED` or `TIMED_OUT`; no silent success.                                  |
| `STREAM_TRANSPORT_TIMEOUT`       | `STOP_ACK_RECONCILING` or `TRANSCRIPT_PENDING`, then bounded terminal stream outcome                                          | `TRANSCRIPT_READY`                                 | False only with no durable transcript            | Socket-close/inactivity fallback terminalizes stream as `FAILED` or `TIMED_OUT`.         |
| `STT_TIMEOUT`                    | `TRANSCRIPT_PENDING`, then `TRANSCRIPT_TERMINAL_FAILED` only if no transcript exists                                          | `TRANSCRIPT_READY`                                 | False only with no durable transcript            | Failed/timed-out stream remains diagnostic.                                              |
| `STT_PERSISTENCE_FAILED`         | `TRANSCRIPT_PENDING`, then `TRANSCRIPT_TERMINAL_FAILED` only if no transcript exists                                          | `TRANSCRIPT_READY`                                 | False only with no durable transcript            | Durable transcript unavailable for that stream.                                          |
| `TRANSCRIPT_INCOMPLETE`          | `TRANSCRIPT_PENDING`                                                                                                          | `TRANSCRIPT_READY`                                 | False only until first durable transcript exists | Recovery/finalization continues within deadline.                                         |
| `TRANSCRIPT_UNAVAILABLE`         | `TRANSCRIPT_TERMINAL_FAILED` only when all streams terminal and server state known                                            | `TRANSCRIPT_READY`                                 | False only with no durable transcript            | Canonical no-transcript terminal condition.                                              |
| `NO_SPEECH_DETECTED`             | `TRANSCRIPT_TERMINAL_FAILED` only when all streams terminal and server state known                                            | `TRANSCRIPT_READY`                                 | False only with no durable transcript            | Error code, not realtime status.                                                         |
| `FAILED_AUDIO_CAPTURE`           | `TRANSCRIPT_TERMINAL_FAILED` only when all streams terminal and server state known                                            | `TRANSCRIPT_READY`                                 | False only with no durable transcript            | Error code, not realtime status.                                                         |

### 9.7.2 Stop-Control and Reconciliation Errors

| Error Code                      | Realtime Status Without Any Durable Transcript | Realtime Status When Any Durable Transcript Exists          | Analysis Eligibility           | Final Effect                                                                             |
| ------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `STOP_CONTROL_DISPATCH_TIMEOUT` | `STOP_ACK_RECONCILING`                         | `TRANSCRIPT_READY` with `meeting_finalization_pending=true` | Depends on transcript evidence | Control was not dispatched; reconcile until `T_user_stop + 20 seconds`.                  |
| `STOP_ACK_TIMEOUT`              | `STOP_ACK_RECONCILING`                         | `TRANSCRIPT_READY` with `meeting_finalization_pending=true` | Depends on transcript evidence | Control was dispatched but ACK was not received after bounded retries.                   |
| `SESSION_STATE_UNAVAILABLE` | `SESSION_TERMINAL_FAILED` | `SESSION_TERMINAL_FAILED` while retaining any durable transcript already persisted | True when a durable transcript exists; otherwise False | At reconciliation deadline, no cutoff or analysis job is created. Keep `analysis_status=NOT_STARTED`; expose `analysis_execution_blocked_reason=SESSION_STATE_UNAVAILABLE`. |
| `STALE_STATUS_QUERY`            | Current state unchanged                        | Current state unchanged                                     | Current state unchanged        | Stale query is rejected or clearly marked and cannot overwrite current UI.               |

When `analysis_eligible=true` but analysis execution is blocked because
Section 9.4 Rules 4–6 cannot be satisfied, `analysis_status` remains
`NOT_STARTED`, no analysis job or cutoff is created, and
`analysis_execution_blocked_reason` is required.

`analysis_blocked_reason` remains mandatory when `analysis_eligible=false`.

### 9.7.3 Analysis Errors

Only analysis/provider-domain errors may change `analysis_status` to `RETRYABLE_FAILED` or `FAILED`, and only after `analysis_eligible=true` and an analysis job exists.

| Error Code                 | Analysis Status While Retriable | Analysis Eligibility | Final Effect                                    |
| -------------------------- | ------------------------------- | -------------------- | ----------------------------------------------- |
| `ANALYSIS_PROVIDER_FAILED` | `RETRYABLE_FAILED`              | True                 | Retry budget/deadline exhausted -> `FAILED`.    |
| `ANALYSIS_TIMEOUT`         | `RETRYABLE_FAILED`              | True                 | Retry budget/deadline exhausted -> `FAILED`.    |
| `GEMINI_QUOTA_EXHAUSTED`   | `RETRYABLE_FAILED`              | True                 | No permitted provider path remains -> `FAILED`. |
| `ANALYSIS_INTERNAL_ERROR`  | `RETRYABLE_FAILED`              | True                 | Retry budget/deadline exhausted -> `FAILED`.    |

## 9.8 Canonical Response Models

### 9.8.1 Transcript Terminal Failure with No Durable Transcript

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "attempt_id": 2,
  "status_version": 17,
  "authoritative_at": "2026-07-01T12:00:00Z",
  "realtime_status": "TRANSCRIPT_TERMINAL_FAILED",
  "analysis_status": "NOT_STARTED",
  "analysis_eligible": false,
  "analysis_blocked_reason": "TRANSCRIPT_UNAVAILABLE",
  "error_code": "TRANSCRIPT_UNAVAILABLE"
}
```

### 9.8.2 One Stream Fails, Another Has a Durable Transcript

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "attempt_id": 2,
  "status_version": 18,
  "authoritative_at": "2026-07-01T12:00:03Z",
  "realtime_status": "TRANSCRIPT_READY",
  "analysis_status": "NOT_STARTED",
  "analysis_eligible": true,
  "meeting_finalization_pending": false,
  "stream_diagnostics": [
    {
      "stream_id": "mic",
      "attempt_id": 2,
      "stream_state": "FAILED",
      "error_code": "STT_PERSISTENCE_FAILED"
    }
  ]
}
```

### 9.8.3 Durable Transcript While Another Stream Is Still Reconciling

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "attempt_id": 2,
  "status_version": 19,
  "authoritative_at": "2026-07-01T12:00:05Z",
  "realtime_status": "TRANSCRIPT_READY",
  "meeting_finalization_pending": true,
  "analysis_status": "NOT_STARTED",
  "analysis_eligible": true,
  "stream_diagnostics": [
    {
      "stream_id": "mic",
      "attempt_id": 2,
      "stream_state": "FINALIZING",
      "control_status": "STOP_ACK_RECONCILING",
      "error_code": "STOP_ACK_TIMEOUT"
    }
  ]
}
```

### 9.8.4 Stop Acknowledgement Reconciliation with No Durable Transcript Yet

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "attempt_id": 2,
  "status_version": 20,
  "authoritative_at": "2026-07-01T12:00:07Z",
  "realtime_status": "STOP_ACK_RECONCILING",
  "analysis_status": "NOT_STARTED",
  "analysis_eligible": false,
  "analysis_blocked_reason": "SESSION_RECONCILIATION_PENDING",
  "error_code": "STOP_ACK_TIMEOUT",
  "remaining_control_retries": 0,
  "reconcile_after_seconds": 2
}
```

### 9.8.5 Analysis Running

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "analysis_request_id": "analysis-req-123",
  "analysis_status_version": 12,
  "authoritative_at": "2026-07-01T12:00:10Z",
  "current_attempt_id": 2,
  "origin_attempt_id": 1,
  "included_attempt_ids": [1, 2],
  "analysis_status": "RUNNING",
  "analysis_eligible": true,
  "analysis_input_cutoff_at": "2026-07-01T12:00:20Z"
}
```

### 9.8.6 Analysis Retryable Failure

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "analysis_request_id": "analysis-req-123",
  "analysis_status_version": 13,
  "authoritative_at": "2026-07-01T12:00:30Z",
  "current_attempt_id": 2,
  "origin_attempt_id": 1,
  "included_attempt_ids": [1, 2],
  "analysis_status": "RETRYABLE_FAILED",
  "analysis_eligible": true,
  "analysis_input_cutoff_at": "2026-07-01T12:00:20Z",
  "error_code": "ANALYSIS_PROVIDER_FAILED",
  "retry_owner": "server",
  "retry_after_seconds": 5,
  "remaining_attempts": 3,
  "retry_deadline_at": "2026-07-01T12:00:57Z"
}
```

### 9.8.7 Analysis Terminal Failure

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "analysis_request_id": "analysis-req-123",
  "analysis_status_version": 14,
  "authoritative_at": "2026-07-01T12:00:57Z",
  "current_attempt_id": 2,
  "origin_attempt_id": 1,
  "included_attempt_ids": [1, 2],
  "analysis_status": "FAILED",
  "analysis_eligible": true,
  "analysis_input_cutoff_at": "2026-07-01T12:00:20Z",
  "error_code": "ANALYSIS_PROVIDER_FAILED",
  "remaining_attempts": 0
}
```

## 9.9 Analysis Retry Contract

### 9.9.1 `RETRYABLE_FAILED` Requirements

A `RETRYABLE_FAILED` response must include:

* `retry_owner="server"`;
* `retry_after_seconds > 0`;
* `remaining_attempts >= 1`;
* `retry_deadline_at`;
* `analysis_request_id`;
* a bounded server retry policy.

FE waits and polls while `retry_owner="server"`; it must not submit a duplicate analysis job.

### 9.9.2 Deadline and Exhaustion Rules

* `retry_owner="server"` for all provider/analysis retries.
* FE only polls; it never submits duplicate analysis jobs.
* `RETRYABLE_FAILED` is an intermediate analysis state only.
* `RETRYABLE_FAILED` must never be treated as a terminal user-facing analysis result.
* `frontend_stop_to_analysis_terminal_ms` ends only at:

  * `SUCCEEDED`; or
  * `FAILED`.
* Backend analysis terminal metric ends only at:

  * `SUCCEEDED`; or
  * `FAILED`.
* At the server analysis deadline, unfinished analysis transitions to `FAILED`.
* At frontend `T_user_stop + 60 seconds`, FE requires `SUCCEEDED` or `FAILED`.
* `RETRYABLE_FAILED` is allowed only while both applicable server and frontend deadlines remain unexpired.
* Transport, capture, transcript, persistence, framing, and stop-control errors must never produce `analysis_status=RETRYABLE_FAILED`.

### 9.9.3 Status Transition Table

| Status             | `remaining_attempts` | `retry_after_seconds` | Terminal | FE Behavior                                   |
| ------------------ | -------------------- | --------------------- | -------- | --------------------------------------------- |
| `RETRYABLE_FAILED` | `>= 1`               | `> 0`                 | No       | Wait and poll; do not execute analysis again. |
| `FAILED`           | `0`                  | Absent                | Yes      | Render terminal failure; do not retry.        |
| `SUCCEEDED`        | Absent               | Absent                | Yes      | Render success.                               |
| `PENDING`          | Optional             | Optional              | No       | Wait for status update.                       |

# 10. Deadline, Timeout, Backpressure, and SLA Contract

## 10.1 User-Facing Stop Event Model

Define:

```text
T_user_stop:
The monotonic frontend time at which the user presses Stop.
It is the user-facing SLA reference.

T_control_dispatch:
The time at which FE hands a terminal control to WebSocket.send.

T_retry_dispatch:
The time at which FE hands the one allowed replay terminal control to WebSocket.send.

T_server_control_accepted(stream_id):
The server-clock timestamp when processing-service validates and records an
accepted terminal control for one stream.

T_server_transport_terminalized(stream_id):
The server-clock timestamp when bounded socket-close/inactivity terminalizes a
stream whose terminal control was never accepted.

T_server_meeting_terminal_anchor:
The server-clock timestamp when final terminal evidence exists for the last
required expected stream in the current recording_session_id and attempt_id.
```

Rules:

1. At `T_user_stop`, FE starts the final audio flush barrier and stops initiating new capture work.
2. FE must dispatch each initial terminal control through global FIFO by `T_user_stop + 1 second`.
3. The first ACK deadline is `T_control_dispatch + 3 seconds`.
4. Because initial control may dispatch as late as `T_user_stop + 1 second`, latest first ACK deadline may be `T_user_stop + 4 seconds`.
5. On the first missing ACK:

   * FE remains in `FINALIZING`;
   * FE appends exactly one idempotent replay behind all already queued global items;
   * replay must be dispatched through the same FIFO rules within `1 second` after first ACK timeout;
   * FE waits up to `3 seconds` from retry dispatch for retry ACK.
6. On the second missing ACK:

   * FE enters `STOP_ACK_RECONCILING`;
   * `error_code=STOP_ACK_TIMEOUT`;
   * `remaining_control_retries=0`;
   * no further terminal-control retransmission is allowed.
7. If initial terminal control or the one allowed replay cannot be dispatched within its applicable bounded dispatch window:

   * FE enters `STOP_ACK_RECONCILING`;
   * `error_code=STOP_CONTROL_DISPATCH_TIMEOUT`;
   * `remaining_control_retries=0`;
   * FE accepts no further chunks;
   * reconciliation continues only until `T_user_stop + 20 seconds`.
8. FE must never report `STOP_ACK_TIMEOUT` for a control that was not dispatched.
9. Reconciliation queries authoritative server state, including terminal stream state, transcript availability, realtime state, analysis state, cutoff state, stream diagnostics, status version, and persisted transcript fragments where supported.
10. Durable transcript or an explicit transcript terminal result must be available by `T_user_stop + 20 seconds`.
11. A terminal user-facing analysis result, `SUCCEEDED` or `FAILED`, must be available by `T_user_stop + 60 seconds`.
12. `RETRYABLE_FAILED` may be shown only before the final user-facing deadline and only while server retry remains permitted.
13. Server-clock timing supports backend diagnosis and operational metrics; it never extends frontend user-facing deadlines.

## 10.2 Reconciliation Status Contract

Do not create an unnecessary new public endpoint. The existing authoritative status query path must satisfy this contract.

A reconciliation request must identify:

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "attempt_id": 2
}
```

The authoritative response must echo those values and include the protocol v2 envelope:

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "attempt_id": 2,
  "status_version": 17,
  "authoritative_at": "2026-07-01T12:00:00Z",
  "realtime_status": "TRANSCRIPT_READY",
  "analysis_status": "NOT_STARTED",
  "analysis_eligible": true,
  "meeting_finalization_pending": false,
  "terminal_streams": {},
  "stream_diagnostics": []
}
```

Rules:

1. `status_version` is monotonically increasing per:

   ```text
   meeting_id + recording_session_id + attempt_id
   ```

2. FE must discard a status response when:

   * `meeting_id` differs;
   * `recording_session_id` differs;
   * `attempt_id` differs;
   * `status_version` is lower than the last accepted value for that tuple.

3. Equal `status_version` may be handled idempotently but must not regress visible state.

4. Backend must reject or clearly mark stale status queries with:

   ```text
   STALE_STATUS_QUERY
   ```

5. Reconciliation can resolve to:

   * `TRANSCRIPT_READY`;
   * `TRANSCRIPT_TERMINAL_FAILED`;
   * `SESSION_TERMINAL_FAILED` only when authoritative state cannot be obtained by deadline.

6. Hydration uses the realtime identity/version policy from Section 14.1.1.

7. Analysis polling uses the analysis identity/version policy from Section 14.1.2 and must not be cross-compared with realtime or hydration status versions.

## 10.3 Reconciliation Outcomes

| Outcome                                                                         | Realtime Status                                             | Analysis Status                            | Analysis Eligibility |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ | -------------------- |
| Durable transcript found                                                        | `TRANSCRIPT_READY`                                          | `NOT_STARTED` until analysis job is queued | True                 |
| Durable transcript found while another stream closure remains pending           | `TRANSCRIPT_READY` with `meeting_finalization_pending=true` | `NOT_STARTED` until analysis job is queued | True                 |
| Server state known; all expected streams terminal; no durable transcript exists | `TRANSCRIPT_TERMINAL_FAILED`                                | `NOT_STARTED`                              | False                |
| Authoritative state cannot be obtained before `T_user_stop + 20 seconds` and no durable transcript is known | `SESSION_TERMINAL_FAILED` | `NOT_STARTED` | False |
| Durable transcript already exists, but authoritative state for an unresolved expected stream cannot be obtained by reconciliation deadline | `SESSION_TERMINAL_FAILED` | `NOT_STARTED`; no cutoff/job; `analysis_execution_blocked_reason=SESSION_STATE_UNAVAILABLE` | True |

## 10.4 Backend Operational Targets

| Backend Event                                                                                          | Operational Target                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `T_server_meeting_terminal_anchor` -> durable transcript or terminal transcript result                 | `<= 17 seconds`                                                          |
| `T_server_meeting_terminal_anchor` -> analysis user-visible terminal outcome (`SUCCEEDED` or `FAILED`) | `<= 57 seconds`, also bounded by `analysis_input_cutoff_at + 40 seconds` |

Analysis operational deadline:

```text
min(
  T_server_meeting_terminal_anchor + 57 seconds,
  analysis_input_cutoff_at + 40 seconds
)
```

Rules:

1. These are backend telemetry targets, not replacements for frontend SLA.
2. Backend must not compare its server clock directly against frontend monotonic `T_user_stop`.
3. `retry_deadline_at` is a server-clock timestamp.
4. `RETRYABLE_FAILED` is allowed only before both the server deadline and frontend deadline remain unexpired.
5. At server analysis deadline, unfinished analysis transitions to `FAILED`.
6. Backend operational telemetry remains separate from frontend SLA telemetry.
7. `RETRYABLE_FAILED` is not acceptable at the final 60-second user-facing terminal deadline.
8. If reconciliation proves server acceptance or transport terminalization despite ACK loss, backend timing is used for diagnostics while frontend timing remains authoritative for user experience.

## 10.5 Measurement and Telemetry Ownership

FE measures `T_user_stop` SLA with a monotonic clock.

Backend must not claim that it directly measures `T_user_stop + 20 seconds` or `T_user_stop + 60 seconds` unless a separately defined timing signal and clock limitation are documented.

Frontend duration metrics are:

```text
frontend_stop_to_control_dispatch_ms
frontend_stop_ack_latency_ms
frontend_stop_to_transcript_ms
frontend_stop_to_analysis_terminal_ms
```

Backend duration metrics are:

```text
backend_meeting_terminal_anchor_to_transcript_ms
backend_meeting_terminal_anchor_to_analysis_terminal_ms
terminal_control_accept_latency_ms
```

Rules:

* Durations are metric values, not labels.
* No high-cardinality identifier or transcript data may be a metric label.
* Frontend and backend analysis terminal duration metrics stop only at `SUCCEEDED` or `FAILED`.
* `RETRYABLE_FAILED` never ends a terminal duration metric.

## 10.6 SLA Table

| User Event        | Initial Control Dispatch Deadline | First ACK Deadline               | Replay Dispatch Deadline       | Transcript Deadline        | Terminal Analysis Deadline | Violation Handling                                                                                                                                                                                                                   |
| ----------------- | --------------------------------- | -------------------------------- | ------------------------------ | -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User presses Stop | `T_user_stop + 1 second`          | `T_control_dispatch + 3 seconds` | `first_ack_timeout + 1 second` | `T_user_stop + 20 seconds` | `T_user_stop + 60 seconds` | `STOP_CONTROL_DISPATCH_TIMEOUT` or `STOP_ACK_TIMEOUT` -> reconciliation; `TRANSCRIPT_TERMINAL_FAILED` when state known/no transcript; `SESSION_TERMINAL_FAILED` only when state cannot be obtained; unfinished analysis -> `FAILED`. |

## 10.7 Total Deadline Rule

```text
queue_wait + connect_timeout + read_timeout + local_processing <= total_deadline
```

Alternative implementation model:

```text
absolute_deadline = now + total_deadline

before each blocking step:
    remaining = absolute_deadline - now
    abort if remaining <= 0
```

It is invalid to set:

```text
connect_timeout = total_deadline
read_timeout = total_deadline
```

because wall-clock duration can exceed the intended budget.

## 10.8 Path Budgets

| Path                                | Total Deadline                                                         | Queue Wait                | Connect           | Read              | Cancellation / Late Result Policy                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------- | ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Metadata validation                 | 50 ms                                                                  | N/A                       | N/A               | N/A               | Reject immediately.                                                                                                            |
| Binary validation                   | 100 ms                                                                 | N/A                       | N/A               | N/A               | Invalid binary is never marked accepted.                                                                                       |
| Audio chunk forwarding              | 3 seconds                                                              | `<= 500 ms`               | `<= 500 ms`       | Remaining budget  | Expired work self-aborts; late response ignored if terminal.                                                                   |
| Final audio flush                   | `<= 500 ms`                                                            | Included                  | N/A               | N/A               | Seal highest fully enqueued sequence; record `FINAL_AUDIO_FLUSH_TIMEOUT` on expiry.                                            |
| Initial stop-control dispatch       | `<= 1 second from T_user_stop`                                         | Included                  | N/A               | N/A               | Enter reconciliation with `STOP_CONTROL_DISPATCH_TIMEOUT` if not dispatched.                                                   |
| Stop ACK wait                       | 3 seconds after each control dispatch                                  | N/A                       | `<= 1 second`     | Remaining budget  | First miss permits one replay; second miss enters reconciliation.                                                              |
| Replay dispatch                     | `<= 1 second after first ACK timeout`                                  | Included                  | N/A               | N/A               | If not dispatched, enter `STOP_ACK_RECONCILING` with `STOP_CONTROL_DISPATCH_TIMEOUT`.                                          |
| Transport terminalization fallback  | Within transcript SLA                                                  | Included                  | N/A               | N/A               | Socket-close/inactivity produces `STREAM_TRANSPORT_TIMEOUT` and terminal stream evidence.                                      |
| Stream finalize request             | 5 seconds                                                              | `<= 500 ms`               | `<= 1 second`     | Remaining budget  | Late result cannot overwrite terminal stream result.                                                                           |
| Transcript recovery                 | Remaining transcript SLA, max 10 seconds                               | `<= 1 second`             | `<= 2 seconds`    | Remaining budget  | Cancel where possible; late success cannot trigger duplicate analysis.                                                         |
| Durable transcript/terminal result  | 20 seconds after `T_user_stop`                                         | Includes upstream budgets | N/A               | N/A               | Emit terminal transcript outcome at deadline.                                                                                  |
| Analysis queue + provider execution | No later than server analysis deadline and frontend 60-second deadline | Included                  | Provider-specific | Provider-specific | Retry only within total deadline; unfinished work becomes `FAILED`.                                                            |
| Analysis polling                    | 2 seconds per poll request                                             | N/A                       | Short             | Short             | FE drops only analysis-envelope-stale results; realtime `status_version` and attempt provenance do not order analysis results. |
| STT actor enqueue                   | Existing bounded queue timeout                                         | Included                  | N/A               | N/A               | Queue-full becomes explicit backpressure/error.                                                                                |

### Transport Activity and Inactivity Contract

Before implementation exits Phase 0, the service must define either a heartbeat contract or a maximum transport-activity contract.

The configured inactivity terminalization threshold must be documented, configurable, tested, and compatible with the `T_user_stop + 20 seconds` transcript SLA.

Audio silence alone must not count as transport inactivity unless explicitly defined by the protocol.

Valid transport activity consists only of protocol-defined heartbeat traffic or valid WebSocket application frames.

When the configured inactivity threshold expires without valid transport activity, processing-service must begin bounded socket-close/inactivity terminalization and expose `STREAM_TRANSPORT_TIMEOUT` where applicable.

No numeric threshold, heartbeat message shape, ping/pong behavior, or existing timeout configuration is asserted until Phase 0 obtains `rtk`-verified source evidence or records an approved protocol decision.

## 10.9 Backpressure Rules

* Worker queues must be bounded.
* Queue-full cannot be silently ignored.
* Timeout scheduler and blocking I/O must not share an execution resource when starvation is possible.
* Executor lifecycle cleanup is mandatory.
* Every retry has an owner, maximum attempts, backoff, deadline, and terminal result.
* No infinite retries or polling.
* No global 180-second timeout is permitted on realtime hot paths without documented exception and passing regression test evidence outside this specification.

# 11. Persistence Correctness Contract

## 11.1 Persistence Identity and Provenance

```text
Runtime event / chunk idempotency identity:
meeting_id + recording_session_id + attempt_id + stream_id + seq

Runtime checkpoint / cursor identity:
meeting_id + recording_session_id + attempt_id + stream_id

Durable transcript segment provenance:
meeting_id + recording_session_id + attempt_id + stream_id + segment_id

User-facing display grouping:
meeting_id + recording_session_id + stream_id
```

Rules:

1. `attempt_id` and `recording_session_id` are mandatory runtime provenance for new protocol v2 fragments, checkpoints, cursors, dedupe, sequence tracking, and finalization state.
2. UI may group transcript by meeting/session/source, but must retain attempt provenance internally.
3. A new attempt restarting at `seq=1` must never collide with:

   * a prior attempt fragment;
   * a checkpoint;
   * a dedupe key;
   * a transcript segment;
   * a finalization cursor.
4. Do not claim a migration is automatically required.
5. Implementation must prove current persistence supports this provenance, or introduce an additive backward-compatible persistence extension only after consumer audit proves it is needed.
6. Legacy rows without `recording_session_id` or `attempt_id` remain readable:

   * treat them as read-only legacy provenance;
   * use a documented synthetic display scope such as `legacy`;
   * never merge them with protocol v2 attempt data.
7. Preserve existing `stream_id=""` legacy readability.
8. `"default"` remains frontend display-only and is never persisted.

## 11.2 Persistence Rules

* Authoritative actor meeting identity must be defined and used for final transcript assembly.
* Authoritative actor stream identity must be defined and used for stream-scoped persistence.
* Persistence errors must not be swallowed.
* Transaction rollback must occur for integrity and unexpected persistence exceptions.
* Duplicate finalization must not create duplicate transcript rows.
* A final segment must not be overwritten by a weaker late partial segment.
* Stream-level persistence failure must become `STT_PERSISTENCE_FAILED`.
* A persistence failure on one stream does not globally fail the meeting when another stream has a non-blank durable transcript.
* New protocol v2 persistence, dedupe, cursor, and checkpoint operations must carry `meeting_id`, `recording_session_id`, `attempt_id`, `stream_id`, and the relevant segment or sequence identity.

## 11.3 Compatibility Audit Requirement

Implementation must complete a compatibility audit before adding or changing persistence storage shape.

The audit must prove one of these outcomes:

1. Current persistence already stores or can derive required `recording_session_id` and `attempt_id` provenance for new protocol v2 data without collision; or
2. an additive backward-compatible persistence extension is required.

Rules:

* A migration is not automatically required by this specification.
* Any persistence extension must be additive and preserve legacy reads.
* Legacy rows without `recording_session_id` or `attempt_id` remain read-only legacy provenance.
* Export, history, search, transcript hydration, analysis input construction, and diagnostics consumers must not collapse v2 attempt data into legacy rows.
* `runtime_provenance_collision_total` must be emitted when a collision is detected or prevented by runtime validation.

## 11.4 Analysis Preconditions

Analysis may be queued only when all conditions are true:

1. At least one non-blank durable transcript exists from the current `recording_session_id`.
2. Analysis job creation, execution, and analysis_input_cutoff are governed by Section 9.4 Rules 4–7. T_server_meeting_terminal_anchor is necessary but not sufficient; every expected stream must also reach terminal outcome after chunk drain and STT/persistence finalization.
3. No active automatic analysis job already exists for the same `meeting_id + recording_session_id`.
4. If no active automatic job exists, `analysis_request_id`, immutable `analysis_input_cutoff`, immutable analysis input snapshot, and analysis job state are created atomically.
5. `realtime_status` is not `TRANSCRIPT_TERMINAL_FAILED`.
6. `realtime_status` is not `SESSION_TERMINAL_FAILED`.

Analysis must not be queued when:

* no stream has a non-blank durable transcript;
* every expected stream is terminal and no durable transcript exists;
* persistence has terminally failed on every stream;
* transcript recovery deadline has passed with no valid transcript;
* authoritative server state cannot be obtained by reconciliation deadline;
* an active automatic analysis job already exists for the same `meeting_id + recording_session_id`.

`NO_SPEECH_DETECTED` and `FAILED_AUDIO_CAPTURE` are error codes that may explain `TRANSCRIPT_TERMINAL_FAILED`; they are not realtime status values.

## 11.5 Analysis Eligibility Rules

```text
analysis_eligible =
has_non_blank_durable_transcript_from_any_stream
```

* `analysis_eligible` is independent of `analysis_status`.
* `analysis_eligible` becomes true only after a non-blank durable transcript exists for at least one stream in the current recording session.
* `analysis_status=NOT_STARTED` may coexist with `analysis_eligible=true`.
* `analysis_status` may enter `PENDING`, `RUNNING`, `SUCCEEDED`, `RETRYABLE_FAILED`, or `FAILED` only after an analysis job exists.
* `analysis_blocked_reason` is mandatory whenever `analysis_eligible=false`.
* Failure or incompleteness of another stream must not remove eligibility created by a durable transcript.
* When `analysis_eligible=true` but Section 9.4 Rules 4–6 cannot be
  satisfied, `analysis_status=NOT_STARTED`, no analysis job or
  `analysis_input_cutoff` is created, and
  `analysis_execution_blocked_reason` is mandatory.

# 12. Analysis Input Contract

## 12.1 Source-Preserving Analysis Input

Analysis must receive only non-blank durable transcript segments from the current recording session.

The canonical structured input format is:

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "analysis_request_id": "analysis-req-123",
  "analysis_input_version": 1,
  "segments": [
    {
      "recording_session_id": 10,
      "attempt_id": 2,
      "stream_id": "tab",
      "source_label": "Tab",
      "speaker_label": null,
      "segment_id": "segment-1",
      "start_ms": 0,
      "end_ms": 1200,
      "text": "Sample transcript from tab source."
    }
  ]
}
```

## 12.2 Analysis Snapshot Provenance Policy

When an automatic analysis job is created, create:

```json
{
  "analysis_request_id": "analysis-req-123",
  "meeting_id": 456,
  "recording_session_id": 10,
  "analysis_input_cutoff_at": "2026-07-01T12:00:20Z",
  "included_attempt_ids": [1, 2]
}
```

Rules:

1. Automatic analysis-job idempotency is checked before `analysis_request_id` exists and is keyed by:

   ```text
   meeting_id + recording_session_id
   ```

   No active automatic analysis job may already exist for that key.

2. If no active automatic job exists, create exactly one `analysis_request_id` atomically with the immutable `analysis_input_cutoff`, immutable analysis input snapshot, and analysis job state.

3. An existing analysis job is identified by:

   ```text
   meeting_id + recording_session_id + analysis_request_id
   ```

4. `attempt_id` is provenance of segments, not the sole identity of the job.

5. The immutable analysis snapshot includes only:

   * non-blank durable segments;
   * from the current `recording_session_id`;
   * from valid non-rejected attempts;
   * with `recording_session_id`, `attempt_id`, `stream_id`, `segment_id`, timing, and source identity preserved.

6. Transcript from a replaced attempt may be included when it is durable and belongs to the same `recording_session_id`.

7. Segments from another `recording_session_id` must never enter the snapshot.

8. Reconnect before analysis creation:

   * durable segments from valid earlier attempts remain eligible;
   * the later analysis snapshot may include them with attempt provenance.

9. Reconnect after analysis creation:

   * the active analysis job remains immutable;
   * reconnect does not cancel, mutate, or create a duplicate active automatic analysis job;
   * later segments remain persisted and visible;
   * later segments do not create an automatic new analysis job.

10. A new `recording_session_id` creates a separate future analysis lifecycle. It cannot alter or replace a prior session's analysis result.

11. Add status fields where applicable:

```text
analysis_request_id
analysis_input_cutoff_at
included_attempt_ids
late_transcript_after_cutoff
```

12. Do not log snapshot text or raw analysis input.

## 12.3 Analysis Cutoff Timing

When an automatic analysis job is queued:

```text
analysis_request_id is created.
analysis_input_cutoff_at is recorded.
analysis input becomes immutable.
```

Rules:

1. `analysis_input_cutoff_at` is a server-clock timestamp.

2. Analysis input cutoff must occur no later than the transcript SLA boundary as observed by the system's defined deadline model.

3. Analysis job creation, execution, and analysis_input_cutoff are governed by Section 9.4 Rules 4–7. T_server_meeting_terminal_anchor is necessary but not sufficient; every expected stream must also reach terminal outcome after chunk drain and STT/persistence finalization.

4. Backend operational analysis deadline is:

   ```text
   min(
     T_server_meeting_terminal_anchor + 57 seconds,
     analysis_input_cutoff_at + 40 seconds
   )
   ```

5. Late transcript segments:

   * remain persisted and visible in UI;
   * do not mutate an active analysis job;
   * do not trigger an automatic duplicate analysis job.

6. A future explicit re-analysis feature may create a new `analysis_request_id`, but it is out of scope now.

7. Do not log transcript content or raw analysis input.

## 12.4 Ordering Rules

Segments must be ordered deterministically:

1. `start_ms` ascending;
2. `end_ms` ascending;
3. attempt order ascending for segments in the same recording session;
4. stream order: `tab` -> `mic` -> legacy;
5. `segment_id` stable tie-breaker.

## 12.5 Plain-Text Fallback Format

If an existing analysis provider accepts only plain text, processing-service must generate deterministic text using this required format:

```text
[Tab] Sample transcript from tab source.
[Microphone] Sample transcript from microphone source.
```

Rules:

* Plain text fallback must be generated only from the immutable structured snapshot.
* Full transcript text must not be logged.
* Any diagnostic must reference identity fields, not content.

## 12.6 Preservation Requirements

A failed stream must not cause loss of durable segments from the surviving stream.

Transcript analysis merging must not lose:

* `recording_session_id`;
* `attempt_id`;
* `stream_id`;
* `source_label`;
* optional `speaker_label`;
* timing;
* `segment_id`.

Analysis output must be traceable to:

* `meeting_id`;
* `recording_session_id`;
* `analysis_request_id`;
* `attempt_id`;
* `stream_id`;
* `segment_id`.

Full transcript content must never be logged in telemetry.

## 12.7 Stream Availability for Analysis

* If both streams have transcript, analysis uses the combined source-preserving input only after Section 9.4 Rules 4–7 are satisfied.
* If only one stream has a valid non-blank durable transcript, analysis may use that stream alone only after Section 9.4 Rules 4–7 are satisfied.
* If no stream has a valid non-blank durable transcript, analysis must not start.
* A failed, unavailable, timed-out, or replaced stream reaches terminal state through bounded policy and must not block analysis beyond the transcript SLA.
* Analysis job creation, execution, and analysis_input_cutoff are governed by Section 9.4 Rules 4–7. T_server_meeting_terminal_anchor is necessary but not sufficient; every expected stream must also reach terminal outcome after chunk drain and STT/persistence finalization.

# 13. Source Identity, Speaker Diarization, and UI Rendering

## 13.1 Display Model

```text
[source: Tab] [speaker: Speaker 1 optional] transcript text
[source: Microphone] [speaker: Speaker 2 optional] transcript text
```

Rules:

* `source_label` is derived from `stream_id`.
* `speaker_label` appears only when STT provides verified diarization evidence.
* Tab must not automatically become Speaker 1.
* Mic must not automatically become Speaker 2.
* If diarization is unavailable:

  * render source only; or
  * render `Speaker: Unknown`.
* If one source contains multiple real speakers, display those speaker labels within that source.
* Simultaneous Tab and Mic speech must remain source-separated.
* Timestamp ordering must not remove source identity.
* Reconnect attempt provenance must not be displayed as a speaker identity.

## 13.2 Transcript Ordering

Sort by stable timestamp when available.

For equal timestamps, sort by:

1. finalized event order;
2. `recording_session_id`;
3. `attempt_id`;
4. `tab`;
5. `mic`;
6. legacy/default;
7. `segment_id`.

Never deduplicate segments across different stream identities or different attempts.

Legacy missing stream ID maps only to frontend identity `default`.

# 14. Frontend Hydration, Dedupe, and Stale Response Rules

## 14.1 Mandatory Protocol v2 Response Envelopes

### 14.1.1 Realtime and Hydration Envelope

Protocol v2 authoritative status and transcript hydration responses must include:

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "attempt_id": 2,
  "status_version": 17,
  "authoritative_at": "2026-07-01T12:00:00Z"
}
```

Rules:

1. `status_version` is monotonically increasing for:

   ```text
   meeting_id + recording_session_id + attempt_id
   ```

2. Increment `status_version` whenever an externally visible realtime,
   transcript, or stream diagnostic state changes.

   Analysis lifecycle state, `analysis_request_id`, and
   `analysis_input_cutoff` are ordered only by `analysis_status_version`
   under Section 14.1.2.
   A realtime or hydration response may include `analysis_status` only as an
informational snapshot. FE must not use that field to order, replace, or
regress analysis UI state. Analysis polling under Section 14.1.2 remains the
only authoritative analysis-state response path.

3. FE must discard a realtime or hydration response when:

   * `meeting_id` differs;
   * `recording_session_id` differs;
   * `attempt_id` differs; or
   * `status_version` is lower than the last accepted version for that tuple.

4. Equal `status_version` is idempotent and must not regress visible state.

5. A stale realtime or hydration query is rejected or clearly marked with:

   ```text
   STALE_STATUS_QUERY
   ```

6. Missing meeting remains a real not-found result. It must never map to `NOT_STARTED`.

### 14.1.2 Analysis Polling Envelope

Protocol v2 analysis polling responses must include:

```json
{
  "meeting_id": 456,
  "recording_session_id": 10,
  "analysis_request_id": "analysis-req-123",
  "analysis_status_version": 12,
  "authoritative_at": "2026-07-01T12:00:00Z",
  "current_attempt_id": 2,
  "origin_attempt_id": 1,
  "included_attempt_ids": [1, 2]
}
```

Rules:

1. `analysis_status_version` is monotonically increasing for:

   ```text
   meeting_id + recording_session_id + analysis_request_id
   ```

2. FE must discard an analysis polling response only when:

   * `meeting_id` differs;
   * `recording_session_id` differs;
   * `analysis_request_id` differs; or
   * `analysis_status_version` is lower than the last accepted version for that analysis job.

3. `attempt_id`, `current_attempt_id`, `origin_attempt_id`, and `included_attempt_ids` are provenance fields only for analysis polling. They are not the stale-response identity key.

4. A valid analysis polling result must not be discarded merely because reconnect changed `current_attempt_id`.

5. Equal `analysis_status_version` is idempotent and must not regress visible state.

6. `status_version` must not be used to order, accept, or reject analysis polling responses.

7. A stale analysis polling query is rejected or clearly marked with:

   ```text
   STALE_STATUS_QUERY
   ```

8. Missing analysis request remains a real not-found result. It must never be treated as a stale replay for a different job.

9. Realtime/hydration and analysis polling use different version domains and must not be cross-compared.

## 14.2 Required Regression Cases

| Scenario                                             | Required Behavior                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Tab partial + Mic final with same `segment_id`       | Keep two records.                                                                                            |
| Same `segment_id` in two attempts                    | Keep two records with distinct attempt provenance.                                                           |
| Same `seq` in two attempts                           | Keep distinct runtime events and dedupe identities.                                                          |
| New recording session in one meeting                 | Do not overwrite prior session transcript.                                                                   |
| Tab and Mic with same `dedupe_key`                   | Keep two identities.                                                                                         |
| Legacy missing `stream_id` + Tab/Mic same segment ID | Render distinct legacy/default, tab, and mic identities.                                                     |
| Final arrives before partial                         | Final remains authoritative.                                                                                 |
| Duplicate final                                      | Idempotent update only.                                                                                      |
| Live event overlaps persisted hydration              | Merge only when session, attempt, stream, and segment identity match.                                        |
| Tab/Mic arrival reversed                             | Sort stably; never cross-merge.                                                                              |
| One stream reconnects                                | Finalized stream remains immutable; active stream continues in a new attempt.                                |
| Stale hydration response                             | Drop if envelope no longer matches current recording context.                                                |
| Stale analysis poll response                         | Drop only when the analysis job envelope differs or `analysis_status_version` is lower.                      |
| Current attempt changes for same analysis job        | Accept the valid analysis response when the analysis job envelope and `analysis_status_version` are current. |

## 14.3 Frontend Error Handling Rules

* FE must not infer `TRANSCRIPT_UNAVAILABLE` only because a hydration retry has zero fragments.
* FE must wait for canonical processing-service transcript/analysis status.
* FE may show "finalizing transcript" while within the 20-second transcript SLA.
* After transcript SLA expiry, FE must show a clear terminal/retryable cause rather than infinite loading.
* `STALE_STATUS_QUERY` must not overwrite current UI.
* Missing meeting must remain a real not-found result, not `NOT_STARTED`.
* FE must never use realtime `status_version`, hydration `attempt_id`, or changed analysis provenance to reject a valid analysis polling response.

# 15. Legacy Mixed Tab+Mic Compatibility Plan

## 15.1 Temporary Legacy Mode

Legacy mixed mode is allowed temporarily under the explicit internal mode:

```text
TAB_MIC_LEGACY_MIXED
```

Rules:

* It must be visibly distinguishable from True Dual-stream.
* It may not be selected automatically after dual-stream failure.
* It may be offered before recording begins as a compatibility option.
* It must not be advertised as source-separated transcript mode.
* It must not be used for the mandatory demo/release True Dual-stream flow.

## 15.2 Legacy Mixer Restrictions

* True Dual-stream must not invoke hard-gate mixer behavior.
* Mic activity must not set Tab gain to zero in the True Dual-stream path.
* The legacy hard-gate path remains isolated to explicit legacy mode.
* Legacy mixed recordings remain readable as historical/compatibility recordings.
* Legacy rows without `recording_session_id` or `attempt_id` remain read-only legacy provenance.

## 15.3 Deprecation Gate

Legacy mixed mode may be removed only after:

* True Dual-stream passes Chrome and Edge smoke tests on Windows.
* Tab/Mic source separation is verified end-to-end.
* One-stream failure behavior is verified.
* Reconnect/finalization behavior is stable.
* Runtime telemetry confirms no critical dual-stream invalid-ID, provenance-collision, or persistence failures.
* Export/history/search consumers are audited.
* Support documentation explains old mixed recordings.

# 16. Browser and Version Compatibility

## 16.1 Browser Support Matrix

| Browser        | Operating System | Requirement                |
| -------------- | ---------------- | -------------------------- |
| Google Chrome  | Windows          | Required for demo/release. |
| Microsoft Edge | Windows          | Required for demo/release. |

## 16.2 Browser Behavior Requirements

* Tab audio must be explicitly selected during browser sharing.
* Tab audio `mute`, `unmute`, and `ended` events must create stream-level state.
* Tab track ending must not fail Mic if Mic remains valid.
* Mic permission denial must not fail Tab if Tab remains valid.
* Unsupported behavior must show a clear user-visible message.
* Browser-specific handling must never silently fall back to mixed audio.
* Reconnect must create a new `attempt_id` and reset per-stream sequence scope.

## 16.3 Deployment Compatibility

| Case                                  | Protection                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| New FE + old backend                  | Capability handshake blocks True Dual-stream start or requires explicit Legacy mode before recording begins. |
| Old FE + new backend                  | Backend keeps legacy single-stream support outside dual mode.                                                |
| Rolling processing-service deployment | `session.ready` echoes protocol and status contract.                                                         |
| Rolling ai-api deployment             | Do not enable release Dual-stream until persistence fix and provenance audit are deployed and verified.      |
| Stale browser tab                     | Re-handshake; old queued chunks are dropped.                                                                 |
| Reconnect after deploy                | New attempt identity is required.                                                                            |

# 17. Observability, Privacy, and Metrics

## 17.1 Structured Logging Fields

Allowed in structured logs/traces:

```text
meeting_id
session_id
recording_session_id
attempt_id
stream_id
segment_id
chunk_seq
final_seq
analysis_request_id
trace_id
request_id
error_code
terminal_reason
status_version
```

Allowed fields are identifiers and diagnostics only. Logs must not include transcript content, raw audio, secrets, or provider payloads.

## 17.2 Metric Labels

Allowed low-cardinality metric labels:

```text
service
source_mode
stream_id
status
reason
error_code
protocol_version
browser_family
```

Forbidden metric labels:

```text
meeting_id
session_id
recording_session_id
attempt_id
segment_id
trace_id
user_id
transcript_text
raw_audio
```

Rules:

* Duration values are metric values, never labels.
* No meeting ID, recording session ID, attempt ID, segment ID, trace ID, user ID, transcript text, or raw audio may appear in metric labels.
* No high-cardinality metric labels are allowed.

## 17.3 Privacy Rules

Never log:

* full transcript content;
* raw audio payload;
* token;
* cookie;
* API key;
* provider secret;
* user password;
* authorization header;
* raw analysis input;
* snapshot text.

## 17.4 Required Metrics and Alerts

### 17.4.1 Frontend Duration Metrics

| Metric                                  | Purpose                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `frontend_stop_to_control_dispatch_ms`  | Time from `T_user_stop` to dispatch of terminal control via `WebSocket.send`. |
| `frontend_stop_ack_latency_ms`          | Time from dispatch to receipt of `stream.terminal_ack`.                       |
| `frontend_stop_to_transcript_ms`        | Time from `T_user_stop` to `TRANSCRIPT_READY` or terminal transcript failure. |
| `frontend_stop_to_analysis_terminal_ms` | Time from `T_user_stop` to `SUCCEEDED` or `FAILED`.                           |

### 17.4.2 Backend Duration Metrics

| Metric                                                    | Purpose                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `backend_meeting_terminal_anchor_to_transcript_ms`        | Time from `T_server_meeting_terminal_anchor` to durable/terminal transcript. |
| `backend_meeting_terminal_anchor_to_analysis_terminal_ms` | Time from `T_server_meeting_terminal_anchor` to `SUCCEEDED` or `FAILED`.     |
| `terminal_control_accept_latency_ms`                      | Time to validate and accept a terminal control event.                        |

### 17.4.3 Error, Status, and Lifecycle Counters

| Metric                                       | Purpose                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `stt_persist_failures_total`                 | Detect persistence failures by error code.                                     |
| `realtime_hydration_zero_fragments_total`    | Detect hydration failures without making them terminal by inference.           |
| `dual_stream_invalid_id_total`               | Detect protocol violations.                                                    |
| `stream_sequence_gap_total`                  | Detect missing chunk/final sequence gaps.                                      |
| `stream_transport_timeout_total`             | Detect socket-close/inactivity fallback terminalization.                       |
| `realtime_timeout_total`                     | Detect deadline breaches by path.                                              |
| `analysis_pending_too_long_total`            | Detect analysis SLA breach.                                                    |
| `tab_mic_active_stream_count_mismatch_total` | Detect lifecycle inconsistency.                                                |
| `realtime_queue_full_total`                  | Detect backpressure.                                                           |
| `late_recovery_result_ignored_total`         | Validate terminal-result safety.                                               |
| `tab_track_lifecycle_total`                  | Track mute/unmute/ended behavior by browser.                                   |
| `stop_ack_timeout_total`                     | Detect stop acknowledgement SLA violations.                                    |
| `stop_control_dispatch_timeout_total`        | Detect dispatch timeout for terminal controls.                                 |
| `final_audio_flush_timeout_total`            | Detect final recorder flush deadline breaches.                                 |
| `post_terminal_audio_chunk_total`            | Detect rejected audio beyond a terminal boundary.                              |
| `transcript_sla_breach_total`                | Detect `T_user_stop + 20s` transcript SLA breach.                              |
| `analysis_sla_breach_total`                  | Detect `T_user_stop + 60s` analysis SLA breach.                                |
| `realtime_status_transition_total`           | Track realtime status transitions.                                             |
| `analysis_status_transition_total`           | Track analysis status transitions.                                             |
| `terminal_control_conflict_total`            | Detect conflicting terminal controls.                                          |
| `analysis_input_cutoff_late_segments_total`  | Count durable transcript segments that arrive after immutable analysis cutoff. |
| `stale_status_query_total`                   | Count rejected or clearly marked stale status queries.                         |
| `runtime_provenance_collision_total`         | Count detected or prevented runtime provenance collisions.                     |

Rules:

* Frontend and backend analysis terminal duration metrics stop only at `SUCCEEDED` or `FAILED`.
* `RETRYABLE_FAILED` never ends a terminal duration metric.
* Metrics must not contain high-cardinality labels or sensitive content.

# 18. Remediation Plan

Every implementation PR must include:

```text
Goal
Confirmed evidence
Affected files and methods
Protocol/data impact
Backward compatibility impact
Implementation constraints
Tests to add
Exact test commands
Browser/Docker smoke tests
Rollback scope
Acceptance criteria
Non-goals
```

## 18.0 Phase 0: Verified Transport-Liveness Decision

### Goal

Establish an evidence-based transport activity and inactivity contract before implementation commits to heartbeat behavior, timeout configuration, or socket-close terminalization details.

### Requirements

* Use CodeGraph only to discover the relevant frontend, processing-service, and WebSocket call flow.
* Use `rtk read`, `rtk grep`, and `rtk rg` to verify current source for WebSocket open/close callbacks, explicit ping/pong, application heartbeat, idle-session timeout, timeout configuration, and inactivity terminalization.
* Document either a protocol-defined heartbeat contract or a maximum transport-activity contract.
* Document the configured inactivity terminalization threshold only after `rtk` verifies the source or an approved design decision introduces it.
* Ensure the threshold is configurable, tested, and compatible with the `T_user_stop + 20 seconds` transcript SLA.
* Define valid transport activity as protocol-defined heartbeat traffic or valid WebSocket application frames.
* Do not treat audio silence as transport inactivity unless the protocol explicitly defines that behavior.
* Define bounded socket-close/inactivity terminalization and `STREAM_TRANSPORT_TIMEOUT` behavior where applicable.
* Do not assume a numeric threshold, browser ping/pong behavior, or existing configuration key without `rtk`-verified evidence.

### Required Tests

* Valid transport activity prevents inactivity terminalization even when audio content is silent.
* No valid transport activity beyond the configured threshold triggers bounded socket-close/inactivity terminalization.
* Audio silence alone does not trigger transport inactivity unless explicitly defined by the protocol.
* The threshold allows transcript terminal result or authoritative reconciliation within `T_user_stop + 20 seconds`.

### Acceptance Criteria

* The Evidence Register and OQ-04 are updated from `rtk`-verified source evidence or remain explicitly `OPEN QUESTION`.
* The selected transport contract, configuration ownership, and bounded terminalization path are documented.
* No implementation phase exits with an invented numeric inactivity threshold or unverified heartbeat behavior.

## 18.1 Phase 1: ai-api Persistence Integrity and Runtime Provenance

### Goal

Fix final transcript assembly so final persistence cannot fail on undefined meeting identity, and ensure new protocol v2 runtime provenance cannot collide across sessions or attempts.

### Requirements

* Replace undefined meeting ID usage with authoritative actor meeting ID.
* Preserve existing `stream_id=""` legacy storage readability.
* Preserve stream checkpoint ownership while adding or proving session/attempt provenance.
* Propagate final persistence failure accurately.
* Perform compatibility audit before any persistence extension.
* Ensure runtime event, checkpoint, cursor, dedupe, and transcript segment identities include `recording_session_id` and `attempt_id` for protocol v2 data.
* Treat legacy rows without `recording_session_id` or `attempt_id` as read-only legacy provenance.

### Required Tests

* Finalization with STT response.
* Finalization requiring assembled transcript.
* Duplicate finalization.
* Tab, Mic, and legacy stream IDs.
* Persistence rollback.
* Actor failure propagation.
* One stream persistence failure while another stream has valid transcript.
* Reconnect attempt starts at `seq=1` without collision.
* Same `segment_id` in two attempts remains distinct.
* Same `seq` in two attempts remains distinct.
* New recording session in one meeting does not overwrite old transcript.
* Legacy rows remain readable.

### Acceptance Criteria

* No undefined local variable in final assembly.
* Final checkpoint updates correctly.
* Durable transcript retrieval succeeds after finalization.
* One valid source transcript still permits analysis eligibility.
* Protocol v2 persistence/dedupe/finalization identity is collision-safe across attempts and recording sessions.
* No migration is claimed unless compatibility audit proves it is needed.

## 18.2 Phase 2: True Dual-stream Protocol and Lifecycle

### Goal

Make `TAB_MIC_DUAL` the required demo/release path and implement correct terminal ACK semantics with global FIFO queue, sequence scope, reconnection, and server terminal anchors.

### Requirements

* Implement/verify protocol v2 handshake.
* Use `stream.stop(final_seq)` for protocol v2.
* Add `stream.unavailable`.
* Keep external sequence values non-negative.
* Translate to internal legacy `seq=-1` only at adapter boundary if still required.
* Maintain `expected_streams`, `active_streams`, and `terminal_streams`.
* Do not use hard-gate mixer in True Dual-stream.
* Do not silently downgrade to Legacy Mixed mode.
* Implement `stream.terminal_ack` with `ACCEPTED`, `IDEMPOTENT_REPLAY`, and `REJECTED`.
* Ensure `accepted=true` only for first valid or exact duplicate controls.
* Ensure accepted `stream.stop` reports `stream_state=FINALIZING`, never `FINALIZED`.
* Echo `terminal_reason` in every terminal acknowledgement.
* Implement final audio flush barrier.
* Enforce one global FIFO outbound queue with atomic metadata-binary pairs.
* Reject post-terminal audio.
* Distinguish `STOP_CONTROL_DISPATCH_TIMEOUT` from `STOP_ACK_TIMEOUT`.
* Implement initial stop-control dispatch deadline, ACK deadline, one replay, replay dispatch deadline, and reconciliation.
* Implement bounded socket-close/inactivity terminalization when no control reaches backend.
* Implement the Phase 0 transport activity/inactivity contract without treating audio silence as inactivity unless explicitly defined.
* Create `T_server_meeting_terminal_anchor` from accepted controls or transport fallback terminal evidence.
* Preserve protocol v1 compatibility at the boundary and strict v2 snake_case after handshake.

### Required Tests

* Tab and Mic each start at sequence 1.
* Same `segment_id` on Tab and Mic remains separate.
* Tab stops before Mic.
* Mic stops before Tab.
* Mic permission denied + Tab works.
* Tab track ended + Mic works.
* Final recorder flush produces last audio pair before `final_seq` seals.
* Final-flush timeout sends bounded `capture_timeout` control and records `FINAL_AUDIO_FLUSH_TIMEOUT`.
* `final_seq=0` succeeds for a started stream with no chunk.
* `highest_contiguous_accepted_seq` prevents hidden middle-sequence gap.
* Duplicate identical stop returns `IDEMPOTENT_REPLAY`.
* Different `final_seq`, terminal reason, or control type returns `TERMINAL_CONTROL_CONFLICT`.
* `stream.stop` ACK echoes `terminal_reason`.
* `stream.unavailable` ACK echoes `terminal_reason`.
* Post-stop `seq > final_seq` and every post-unavailable chunk are rejected as `POST_TERMINAL_AUDIO_CHUNK`.
* Reconnect sequence scope is isolated by `attempt_id`.
* Old attempt events are rejected.
* Mic first utterance within first 0-2 seconds persists.
* Tab `mute`, `unmute`, `ended` lifecycle works.
* Global FIFO ordering enforced; control event between metadata and binary rejected.
* First missing ACK sends one replay.
* Replay dispatch timeout enters reconciliation with `STOP_CONTROL_DISPATCH_TIMEOUT`.
* Second missing ACK enters reconciliation with `STOP_ACK_TIMEOUT`.
* Control unavailable at backend still reaches bounded terminal state through socket-close/inactivity handling.
* Valid transport activity prevents inactivity terminalization even when audio is silent.
* No valid transport activity beyond configured threshold enters bounded socket-close/inactivity terminalization.
* Protocol v1 camelCase normalizes at compatibility boundary; v2 camelCase or duplicate aliases are rejected.

### Acceptance Criteria

* Backend receives distinct `tab` and `mic` streams.
* A stream failure does not globally fail a meeting with valid transcript from another stream.
* True Dual-stream never mutates Tab gain because Mic is active.
* Terminal ACK semantics match this specification.
* `T_server_meeting_terminal_anchor` exists for accepted controls and transport fallback.
* Transport activity/inactivity behavior is evidence-based, configurable, and compatible with the transcript SLA.
* Chrome and Edge smoke tests are required before release.

## 18.3 Phase 3: Timeout, Backpressure, and Reconciliation Hardening

### Goal

Ensure realtime operations meet the 20-second transcript SLA and do not block on global long timeouts. Include stop-control dispatch, ACK timing, replay, transport fallback, authoritative reconciliation, and stale-response handling.

### Requirements

* Give audio forwarding a dedicated hot-path budget.
* Enforce total deadline semantics.
* Keep recovery executor separate from timeout scheduler.
* Ensure late recovery/final results cannot trigger duplicate analysis.
* Bound queues, retries, and worker lifetime.
* Add visible queue-full and timeout results.
* Implement bounded final audio flush, stop-control dispatch, replay dispatch, and ACK deadlines.
* Ensure latest first ACK deadline is three seconds after dispatch, not three seconds after `T_user_stop`.
* Ensure reconciliation response includes `meeting_id`, `recording_session_id`, `attempt_id`, `status_version`, and `authoritative_at`.
* Ensure stale status queries are rejected or marked with `STALE_STATUS_QUERY`.
* Apply the Phase 0 transport activity/inactivity contract; do not infer transport inactivity from audio silence.

### Required Tests

* Blocked ai-api recovery.
* Two simultaneous blocked recoveries.
* Timeout scheduler still completes.
* Audio forwarding timeout under three seconds.
* Late recovery success ignored after terminal timeout.
* Queue full/backpressure.
* No path blocks WebSocket flow for an unbounded or globally long timeout.
* Final audio flush barrier captures final recorder chunk before sealing `final_seq`.
* Stop-control dispatch timeout enters reconciliation.
* Replay dispatch timeout enters reconciliation.
* Control unavailable at backend still reaches bounded terminal state through socket-close/inactivity handling.
* No terminal control bypasses FIFO.
* Valid transport activity prevents inactivity terminalization even when audio content is silent.
* No valid transport activity beyond the configured threshold triggers bounded socket-close/inactivity terminalization.
* Audio silence alone does not trigger transport inactivity unless explicitly defined by the protocol.
* The configured threshold permits transcript terminal result or authoritative reconciliation within `T_user_stop + 20 seconds`.
* Authoritative durable transcript found.
* Authoritative transcript terminal failure found.
* No authoritative status by deadline produces `SESSION_TERMINAL_FAILED`.

### Acceptance Criteria

* Transcript or terminal transcript status appears by `T_user_stop + 20 seconds`.
* Reconciliation remains meaningful when no terminal control reached backend.
* Frontend stale responses cannot overwrite current state.
* `SESSION_TERMINAL_FAILED` and `TRANSCRIPT_TERMINAL_FAILED` remain non-overlapping.

## 18.4 Phase 4: Analysis Status, Snapshot, and Deadline Ownership

### Goal

Make analysis eligibility, job creation, immutable input cutoff, retry ownership, stale polling, and deadline behavior deterministic.

### Requirements

* Preserve meeting-level eligibility:

  ```text
  analysis_eligible =
  has_non_blank_durable_transcript_from_any_stream
  ```

* Analysis job creation, execution, and analysis_input_cutoff are governed by Section 9.4 Rules 4–7. T_server_meeting_terminal_anchor is necessary but not sufficient; every expected stream must also reach terminal outcome after chunk drain and STT/persistence finalization.

* Before `analysis_request_id` exists, enforce no active automatic analysis job for the same `meeting_id + recording_session_id`.

* If no active automatic job exists, atomically create exactly one `analysis_request_id`, immutable analysis input cutoff, immutable analysis input snapshot, and analysis job state.

* Preserve `recording_session_id`, `attempt_id`, `stream_id`, `segment_id`, timing, and source identity in snapshot.

* Allow durable segments from valid replaced attempts in the same recording session to be included before cutoff.

* Exclude segments from other recording sessions.

* Do not mutate, cancel, or duplicate active analysis merely because reconnect begins.

* Map `QUEUED` and `NOT_READY` conditionally.

* Keep missing meeting as real not-found.

* Keep `RETRYABLE_FAILED` intermediate only.

* Use backend operational deadline:

  ```text
  min(
    T_server_meeting_terminal_anchor + 57 seconds,
    analysis_input_cutoff_at + 40 seconds
  )
  ```

* At server deadline, unfinished analysis transitions to `FAILED`.

* At frontend deadline, FE requires `SUCCEEDED` or `FAILED`.

### Required Tests

* `NOT_READY` with transcript absent maps to `NOT_STARTED` plus `TRANSCRIPT_PENDING`.
* `NOT_READY` with analysis job created and durable transcript maps to `PENDING`.
* Eligibility can be true before final closure.
* Analysis job creation, execution, and cutoff satisfy Section 9.4 Rules 4–7; terminal anchor alone is insufficient.
* An accepted `stream.stop` alone does not create cutoff or job.
* An unresolved stream at transcript deadline is reconciled to a terminal outcome; unavailable authoritative state yields `SESSION_TERMINAL_FAILED` with no cutoff or job.
* No active automatic job is keyed by `analysis_request_id` before it exists; the active-job check is `meeting_id + recording_session_id`.
* `analysis_request_id`, cutoff, snapshot, and job state are created atomically only after the active-job check succeeds.
* Analysis cutoff input is immutable.
* Snapshot contains only current `recording_session_id`.
* Snapshot preserves attempt provenance.
* Valid previous attempt durable segments can be included.
* Late durable transcript does not mutate active analysis.
* Late durable transcript does not create duplicate automatic job.
* Reconnect after job creation does not duplicate or cancel active job automatically.
* New recording session has separate analysis lifecycle.
* One stream success preserves eligibility while another stream is unresolved.
* `RETRYABLE_FAILED` cannot survive server deadline.
* Terminal frontend analysis metric only ends at `SUCCEEDED` or `FAILED`.

### Acceptance Criteria

* Analysis status is never used to represent capture, STT, persistence, or transport failures.
* FE never submits duplicate analysis jobs.
* Active analysis input is immutable.
* Reconnect cannot cancel, mutate, or create a duplicate active automatic analysis job.
* Automatic re-analysis remains out of scope.
* `RETRYABLE_FAILED` is never a terminal user-facing result.

## 18.5 Phase 5: Frontend Hydration, UI Identity, and Browser Release

### Goal

Render source identity correctly, preserve attempt provenance internally, handle stale envelopes safely, and validate release browsers.

### Requirements

* Preserve Tab/Mic/default identity during hydration.
* Preserve attempt provenance internally even if UI groups by session/source.
* Do not cross-merge Tab and Mic transcript rows.
* Do not cross-merge attempts or recording sessions.
* Display source separately from speaker diarization.
* Drop stale realtime and hydration responses by `meeting_id + recording_session_id + attempt_id` and lower `status_version` only.
* Drop stale analysis polling responses by `meeting_id + recording_session_id + analysis_request_id` and lower `analysis_status_version` only.
* Treat analysis attempt fields as provenance only; a changed current attempt does not invalidate a valid analysis response.
* Maintain legacy `stream_id=""` readability with display-only `default`.
* Validate Chrome and Edge on Windows.
* Show explicit unsupported behavior rather than fallback to mixed audio.

### Required Tests

* Tab partial + Mic final with same `segment_id`.
* Same `segment_id` across attempts remains distinguishable.
* Legacy missing stream ID remains readable.
* Final arrives before partial.
* Duplicate final.
* Stale hydration response dropped.
* Stale analysis poll response dropped.
* Wrong realtime meeting/session/attempt identity is dropped.
* Wrong analysis meeting/session/request identity is dropped.
* Lower realtime `status_version` is dropped; equal realtime `status_version` is idempotent.
* Lower `analysis_status_version` is dropped; equal `analysis_status_version` is idempotent.
* A valid analysis result is retained when only current attempt provenance changes.
* Missing meeting remains not-found.
* `STALE_STATUS_QUERY` cannot overwrite current UI.
* Chrome smoke test.
* Edge smoke test.
* One stream failure with other stream transcript still creates cutoff/job only after Section 9.4 Rules 4–7 are satisfied.

### Acceptance Criteria

* UI never presents source identity as speaker diarization.
* Hydration and polling cannot regress visible state.
* Required browser smoke evidence is a release gate.

# 19. Test Strategy and Commands

## 19.1 Test Evidence Rules

* This specification defines required tests; it does not claim tests have passed.
* Each implementation PR must provide exact commands and evidence.
* Browser smoke evidence must identify browser family and operating system without logging transcript text or raw audio.
* Test fixtures may use controlled non-sensitive transcript text only inside test data, not runtime logs.

## 19.2 Markdown and Document Integrity Tests

* File has valid `#`, `##`, and `###` headings.
* All 23 top-level sections exist.
* Tables use Markdown pipe syntax.
* No malformed code fence.
* Version is 3.8.
* The document starts exactly with `# Realtime Runtime Remediation Specification`.
* The document ends after the final Definition of Done bullet.

## 19.3 Protocol and Lifecycle Tests

* Final recorder chunk is included before `final_seq` seals.
* `final_seq=0` succeeds for a started stream with no chunk.
* `highest_contiguous_accepted_seq` prevents hidden middle-sequence gap.
* `stream.stop` ACK echoes `terminal_reason`.
* `stream.unavailable` ACK echoes `terminal_reason`.
* Exact replay returns `IDEMPOTENT_REPLAY`.
* Conflicting control returns `TERMINAL_CONTROL_CONFLICT`.
* Post-stop and post-unavailable audio rejection.
* Reconnect sequence scope is isolated by `attempt_id`.
* Old attempt events are rejected.
* No sequence comparison crosses stream or attempt boundaries.
* `seq=-1` is rejected externally in protocol v2.

## 19.4 Runtime Provenance and Reconnect Tests

* New attempt `seq=1` does not collide with old attempt `seq=1`.
* New `recording_session_id` does not overwrite prior session transcript.
* Same `segment_id` across attempts remains distinguishable.
* Same `seq` across attempts remains distinguishable.
* Old attempt events cannot mutate current state.
* Legacy rows remain readable without collision.
* Replaced attempt durable transcript remains available for same-session analysis snapshot when valid.

## 19.5 Queue and Transport Tests

* Initial control dispatch timeout.
* Replay dispatch timeout.
* First missing ACK sends one replay.
* Second missing ACK enters reconciliation.
* Control unavailable at backend still reaches bounded terminal state through socket-close/inactivity handling.
* No terminal control bypasses FIFO.
* Atomic metadata-binary pair cannot interleave.
* Control between metadata and binary is rejected.
* Queue-full becomes structured backpressure.
* Transport terminalization uses `STREAM_TRANSPORT_TIMEOUT`.
* Valid transport activity prevents inactivity terminalization even when audio content is silent.
* No valid transport activity beyond configured threshold triggers bounded socket-close/inactivity terminalization.
* Audio silence alone does not trigger transport inactivity unless explicitly defined by the protocol.
* The configured threshold allows transcript terminal result or authoritative reconciliation within `T_user_stop + 20 seconds`.

## 19.6 Terminal Anchor and Transport Fallback Tests

* Normal final controls create `T_server_meeting_terminal_anchor`.
* `stream.unavailable` counts as terminal evidence.
* Socket-close/inactivity fallback creates terminal anchor if no control arrives.
* Server terminal fallback resolves bounded `FAILED` or `TIMED_OUT` state.
* Reconciliation becomes meaningful after control dispatch failure.
* Backend transcript metric starts at `T_server_meeting_terminal_anchor`.
* Backend analysis metric starts at `T_server_meeting_terminal_anchor`.

## 19.7 Reconciliation and Stale State Tests

* Status response echoes `meeting_id`, `recording_session_id`, `attempt_id`, `status_version`, and `authoritative_at`.
* Hydration response echoes `meeting_id`, `recording_session_id`, `attempt_id`, `status_version`, and `authoritative_at`.
* Analysis polling response echoes `meeting_id`, `recording_session_id`, `analysis_request_id`, `analysis_status_version`, `authoritative_at`, `current_attempt_id`, `origin_attempt_id`, and `included_attempt_ids`.
* Stale realtime or hydration meeting/session/attempt identity is dropped.
* Wrong analysis meeting/session/request identity is dropped.
* Lower realtime `status_version` is dropped; equal realtime `status_version` is idempotent.
* Lower `analysis_status_version` is dropped; equal `analysis_status_version` is idempotent.
* A valid analysis result is not dropped when only `attempt_id`, `current_attempt_id`, `origin_attempt_id`, or `included_attempt_ids` provenance changes.
* Realtime `status_version` never orders or rejects analysis polling.
* Authoritative durable transcript found.
* Authoritative transcript terminal failure found.
* No authoritative status by deadline produces `SESSION_TERMINAL_FAILED`.
* Missing meeting remains a real not-found result.
* `STALE_STATUS_QUERY` cannot overwrite current UI.

## 19.8 Analysis Tests

* `NOT_READY` with transcript absent maps to `NOT_STARTED` plus `TRANSCRIPT_PENDING`.
* `NOT_READY` with analysis job created and durable transcript maps to `PENDING`.
* Eligibility can be true before final closure.
* Analysis job creation, execution, and cutoff satisfy Section 9.4 Rules 4–7; terminal anchor alone is insufficient.
* Accepted `stream.stop` alone does not create `analysis_input_cutoff` or an analysis job.
* Transcript deadline with unresolved stream requires authoritative reconciliation to a terminal stream outcome.
* No authoritative state by reconciliation deadline yields `SESSION_TERMINAL_FAILED`, no `analysis_input_cutoff`, and no analysis job.
* No active automatic analysis job is checked by `meeting_id + recording_session_id`, before `analysis_request_id` exists.
* `analysis_request_id`, immutable cutoff, immutable snapshot, and job state are atomically created only after the active-job check succeeds.
* Analysis cutoff input is immutable.
* Snapshot contains only current `recording_session_id`.
* Snapshot preserves attempt provenance.
* Valid previous attempt durable segments can be included.
* Late durable transcript does not mutate active analysis.
* Late durable transcript does not create duplicate automatic job.
* Reconnect after job creation does not duplicate, cancel, or mutate active job automatically.
* New `recording_session_id` has separate analysis lifecycle.
* One stream success preserves eligibility while another stream is unresolved.
* Analysis deadline uses `min(anchor + 57s, cutoff + 40s)`.
* `RETRYABLE_FAILED` cannot survive server deadline.
* `RETRYABLE_FAILED` cannot remain at frontend final deadline.
* Terminal frontend analysis metric only ends at `SUCCEEDED` or `FAILED`.
* Backend analysis terminal metric only ends at `SUCCEEDED` or `FAILED`.
* Durable transcript exists from one stream, but authoritative state for an
  unresolved other stream cannot be obtained by reconciliation deadline:
  preserve `analysis_eligible=true`, return `SESSION_TERMINAL_FAILED`, create
  no cutoff or job, and expose `analysis_execution_blocked_reason`.

## 19.9 Persistence and ai-api Tests

* Final persistence bug is covered.
* Final transcript assembly uses defined authoritative meeting ID.
* Stream identity preserved.
* Session and attempt provenance preserved or compatibility extension proven.
* Duplicate finalization idempotent.
* Persistence rollback on failure.
* One stream persistence failure does not erase another stream transcript.
* Legacy rows with missing session/attempt remain readable.
* No transcript text, raw audio, tokens, cookies, API keys, or secrets appear in logs.

## 19.10 Frontend and Browser Smoke Tests

* Chrome on Windows: Mic-only.
* Chrome on Windows: Tab-only.
* Chrome on Windows: True Dual-stream Tab+Mic.
* Chrome on Windows: Mic denied + Tab transcript survives.
* Chrome on Windows: Tab track ended + Mic transcript survives.
* Chrome on Windows: reconnect during dual-stream.
* Edge on Windows: Mic-only.
* Edge on Windows: Tab-only.
* Edge on Windows: True Dual-stream Tab+Mic.
* Edge on Windows: Mic denied + Tab transcript survives.
* Edge on Windows: Tab track ended + Mic transcript survives.
* Edge on Windows: reconnect during dual-stream.
* Browser-specific unsupported behavior shows clear message.
* No browser path silently falls back to Legacy Mixed.


# 20. Rollout and Rollback

## 20.1 Rollout Order

1. Complete Phase 0 transport-liveness verification or approved transport contract decision.
2. Ship ai-api persistence integrity fix and provenance audit result.
3. Ship processing-service protocol v2 compatibility parsing and canonical snake_case validation.
4. Ship terminal control, global FIFO, final audio flush, and sequence-scope updates behind negotiated protocol capability.
5. Ship socket-close/inactivity terminalization and `T_server_meeting_terminal_anchor` under the Phase 0 transport activity contract.
6. Ship authoritative status/hydration envelope and the separate analysis polling envelope.
7. Ship analysis snapshot/cutoff and job creation, execution, and cutoff behavior governed by Section 9.4 Rules 4–7.
8. Ship frontend True Dual-stream release path.
9. Run Chrome and Edge Windows smoke matrix.
10. Enable True Dual-stream Tab+Mic as mandatory demo/release path.
11. Keep Legacy Mixed only as explicit temporary compatibility mode.

## 20.2 Rollback Rules

* Rollback must not corrupt existing transcript persistence.
* Rollback must preserve legacy single-stream sessions.
* Rollback must not allow silent fallback from True Dual-stream to Legacy Mixed after a True Dual-stream start.
* If protocol v2 backend is rolled back, FE must block True Dual-stream start through capability handshake.
* In-flight protocol v2 sessions must reach bounded terminal outcome or clear user-visible failure.
* Rollback must not delete durable transcript segments from valid attempts.
* Rollback must not mutate active immutable analysis snapshots.

## 20.3 Release Gates

Release is blocked unless:

* Phase 0 has documented and verified either a heartbeat contract or maximum transport-activity contract, including configurable threshold ownership and bounded terminalization behavior.
* Valid transport activity, silent-audio activity, inactivity expiry, and transcript-SLA compatibility tests are included in release gating.
* True Dual-stream Tab+Mic passes required Chrome and Edge smoke tests on Windows.
* Mic-only and Tab-only regressions pass.
* Final audio flush tests pass.
* Sequence scope and reconnect tests pass.
* Runtime provenance collision tests pass.
* Terminal ACK semantics tests pass.
* Post-terminal audio rejection tests pass.
* Socket-close/inactivity fallback tests pass.
* Reconciliation and separate-version-envelope tests pass.
* Analysis cutoff/job creation tests prove Section 9.4 Rules 4–7, active-job idempotency by `meeting_id + recording_session_id`, and atomic creation of request ID, cutoff, snapshot, and job state.
* Analysis snapshot and deadline tests pass.
* `RETRYABLE_FAILED` is not terminal in UI, metrics, release gates, or DoD.
* Required metrics are emitted without high-cardinality labels.
* Privacy checks confirm no transcript text, raw audio, tokens, cookies, API keys, or secrets are logged.
* Legacy Mixed remains explicit only.
* Definition of Done is satisfied.

## 20.4 Rollback Verification

After rollback or partial rollback, verify:

* Existing legacy recordings remain readable.
* Protocol v2 sessions either continue safely or fail with explicit user-visible terminal state.
* No automatic downgrade to Legacy Mixed occurs.
* Reconciliation remains bounded.
* Missing meeting remains not-found.
* Active analysis jobs are not duplicated by reconnect or rollback.
* Metrics do not introduce forbidden labels.

# 21. Technical Debt Prevention Checklist

* [ ] Every protocol v2 external JSON field is snake_case.
* [ ] No new protocol v2 external path accepts camelCase except v1 boundary normalization.
* [ ] No `seq=-1` appears outside the internal legacy adapter boundary.
* [ ] No external protocol v2 `audio.chunk` accepts `seq=0`; `final_seq=0` remains valid only for a started stream with no emitted audio pairs.
* [ ] All sequence state is scoped by `recording_session_id + attempt_id + stream_id`.
* [ ] Runtime persistence/dedupe/finalization identity includes `recording_session_id` and `attempt_id`.
* [ ] Legacy provenance is read-only and cannot merge with v2 attempt data.
* [ ] Global FIFO is the only WebSocket outbound dispatch path.
* [ ] Metadata and binary remain an atomic application-dispatch pair.
* [ ] Terminal controls cannot bypass queued audio pairs.
* [ ] `stream.stop` is accepted as `FINALIZING`, not `FINALIZED`.
* [ ] `terminal_reason` is echoed by every terminal ACK.
* [ ] `highest_contiguous_accepted_seq` determines successful finalization.
* [ ] A higher sequence cannot hide a missing middle sequence.
* [ ] `final_seq=0` is valid for a started stream with no emitted audio.
* [ ] Dispatch timeout and ACK timeout remain separate.
* [ ] One replay maximum is enforced.
* [ ] The transport activity/inactivity contract is `rtk`-verified or remains an explicit Phase 0 open question; audio silence is not treated as inactivity unless protocol-defined.
* [ ] The configured inactivity terminalization threshold is documented, configurable, tested, and compatible with the transcript SLA.
* [ ] Socket-close/inactivity terminalization exists for no-control backend fallback.
* [ ] `T_server_meeting_terminal_anchor` exists for accepted controls and transport fallback.
* [ ] Frontend `T_user_stop` SLA is not replaced by server timing.
* [ ] Analysis eligibility remains separate from analysis job creation.
* [ ] Analysis job creation, execution, and analysis_input_cutoff are governed by Section 9.4 Rules 4–7. T_server_meeting_terminal_anchor is necessary but not sufficient; every expected stream must also reach terminal outcome after chunk drain and STT/persistence finalization.
* [ ] Automatic active-job idempotency is keyed by `meeting_id + recording_session_id`, before `analysis_request_id` is created.
* [ ] `analysis_request_id`, immutable cutoff, immutable snapshot, and analysis job state are created atomically only after no active automatic job exists.
* [ ] Analysis snapshot is immutable and existing jobs are scoped to `meeting_id + recording_session_id + analysis_request_id`.
* [ ] Reconnect cannot mutate, cancel, or duplicate an active analysis job automatically.
* [ ] Realtime/hydration responses are ordered only by their attempt-scoped `status_version`.
* [ ] Analysis polling responses are ordered only by their analysis-job-scoped `analysis_status_version`; attempt fields are provenance only.
* [ ] FE drops stale responses and never regresses visible state.
* [ ] `SESSION_TERMINAL_FAILED` and `TRANSCRIPT_TERMINAL_FAILED` remain non-overlapping.
* [ ] `RETRYABLE_FAILED` is never terminal for UI, metrics, release gates, or DoD.
* [ ] No metric uses high-cardinality labels.
* [ ] No logs contain transcript text, raw audio, tokens, cookies, API keys, authorization headers, passwords, or secrets.

# 22. Open Questions and Deployment Gates

## 22.1 Open Questions

| ID    | Question                                                                                                                                                                                                                                                                                                                                                                  | Owner              | Blocks                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------- |
| OQ-01 | Does current persistence already support `recording_session_id` and `attempt_id` provenance for protocol v2 fragments, checkpoints, cursors, dedupe, sequence tracking, and transcript segments?                                                                                                                                                                          | Persistence owner  | Persistence extension decision        |
| OQ-02 | Which export/history/search consumers assume meeting+stream-only transcript identity?                                                                                                                                                                                                                                                                                     | Product/Backend    | Persistence extension and deprecation |
| OQ-03 | What exact browser event sequences occur for tab mute, unmute, ended, permission denial, and reconnect on Chrome and Edge Windows?                                                                                                                                                                                                                                        | Frontend           | Release                               |
| OQ-04 | What does `rtk`-verified current source show for explicit WebSocket ping/pong, application heartbeat, WebSocket open/close callbacks, idle-session timeout, timeout configuration, and inactivity terminalization? If no contract exists, what documented configurable maximum transport-activity threshold and bounded `STREAM_TRANSPORT_TIMEOUT` path will be approved? | Processing-service | Phase 0 and release                   |
| OQ-05 | What provider retry policy satisfies `min(anchor + 57s, cutoff + 40s)` while still meeting frontend `T_user_stop + 60s`?                                                                                                                                                                                                                                                  | Analysis owner     | Release                               |
| OQ-06 | What explicit UI copy should distinguish True Dual-stream from Legacy Mixed compatibility mode?                                                                                                                                                                                                                                                                           | Product/Design     | Release                               |

## 22.2 Deployment Gates

* Gate 1: Phase 0 transport-liveness evidence or approved transport contract is complete; OQ-04 is resolved or remains explicitly open with release blocked.
* Gate 2: Persistence integrity fix and provenance audit complete.
* Gate 3: Protocol v2 handshake, snake_case validation, and v1 boundary compatibility complete.
* Gate 4: Configurable transport activity/inactivity contract, socket-close/inactivity terminalization, `STREAM_TRANSPORT_TIMEOUT` observability, and `T_server_meeting_terminal_anchor` are complete and tested against the transcript SLA.
* Gate 5: Authoritative status/hydration envelope and separate analysis polling envelope are complete.
* Gate 6: Analysis job creation, execution, and cutoff behavior satisfy Section 9.4 Rules 4–7; active-job idempotency is keyed by `meeting_id + recording_session_id`; request ID, cutoff, snapshot, and job state are atomic.
* Gate 7: Observability and privacy gates complete.
* Gate 8: Chrome and Edge Windows smoke matrix complete.
* Gate 9: Release review confirms `RETRYABLE_FAILED` is intermediate only and never terminal.

# 23. Definition of Done

* [ ] `_persist_pump` final persistence bug is fixed and covered by implementation tests.
* [ ] All 23 top-level sections are present and the document is valid Markdown.
* [ ] Version is 3.8 and Status remains `DESIGN READY FOR IMPLEMENTATION`.
* [ ] Final audio flush is bounded; recorder-generated final data is enqueued before `final_seq` seals.
* [ ] A final-flush timeout records `FINAL_AUDIO_FLUSH_TIMEOUT` and uses the highest fully enqueued sequence with `capture_timeout`.
* [ ] A started stream with no emitted audio pair uses `final_seq=0`.
* [ ] FE dispatches each initial terminal control by `T_user_stop + 1 second` without bypassing global FIFO.
* [ ] The first ACK deadline is three seconds after `WebSocket.send` dispatch, with a latest first ACK deadline of `T_user_stop + 4 seconds`.
* [ ] First missing ACK keeps FE in `FINALIZING` and sends exactly one identical replay through global FIFO.
* [ ] Replay dispatch occurs within one second after first ACK timeout or enters reconciliation with `STOP_CONTROL_DISPATCH_TIMEOUT`.
* [ ] A dispatched replay with missing second ACK enters `STOP_ACK_RECONCILING` with `STOP_ACK_TIMEOUT`.
* [ ] A control that cannot be dispatched enters reconciliation with `STOP_CONTROL_DISPATCH_TIMEOUT`, never `STOP_ACK_TIMEOUT`.
* [ ] FE stops accepting chunks, abandons the affected attempt safely, and prevents unsent old controls from later causing ambiguous lifecycle state when dispatch fails.
* [ ] Phase 0 has `rtk`-verified or approved the transport activity/inactivity contract; no unverified heartbeat behavior or numeric threshold is assumed.
* [ ] Valid transport activity prevents inactivity terminalization even when audio content is silent.
* [ ] No valid transport activity beyond the configured threshold triggers bounded socket-close/inactivity terminalization.
* [ ] Audio silence alone does not trigger transport inactivity unless explicitly defined by the protocol.
* [ ] The configured threshold is documented, configurable, tested, and allows transcript terminal result or authoritative reconciliation within `T_user_stop + 20 seconds`.
* [ ] processing-service provides bounded socket-close/inactivity terminalization when no terminal control reaches it.
* [ ] Socket-close/inactivity terminalization uses `STREAM_TRANSPORT_TIMEOUT` and fits within transcript/reconciliation SLA.
* [ ] Reconciliation is bounded by `T_user_stop + 20 seconds`.
* [ ] `SESSION_TERMINAL_FAILED` is used only when authoritative server state cannot be obtained by reconciliation deadline.
* [ ] `TRANSCRIPT_TERMINAL_FAILED` is used only when authoritative server state is known, all expected streams are terminal, and no durable transcript exists.
* [ ] Durable transcript or explicit terminal transcript result is available within 20 seconds after `T_user_stop`.
* [ ] A terminal user-facing analysis result is available within 60 seconds after `T_user_stop`; unfinished analysis becomes `FAILED`.
* [ ] True Dual-stream is mandatory for the Tab+Mic demo/release flow.
* [ ] Legacy Mixed mode remains explicit and never becomes automatic fallback.
* [ ] Protocol v2 JSON uses snake_case; protocol v1 compatibility is normalized only at boundary.
* [ ] `seq=-1` is external-protocol-invalid and adapter-only internally.
* [ ] `recording_session_id`, `attempt_id`, and per-stream `seq` scope are implemented exactly as specified.
* [ ] Runtime event, checkpoint, cursor, dedupe, finalization, and transcript provenance include `recording_session_id` and `attempt_id` for protocol v2 data.
* [ ] Reconnect resets per-stream sequence scope, old attempt events are rejected, and old attempts cannot block current finalization.
* [ ] A new attempt restarting at `seq=1` cannot collide with a prior attempt fragment, checkpoint, dedupe key, transcript segment, or finalization cursor.
* [ ] A new `recording_session_id` in the same meeting cannot overwrite or merge with a prior session transcript.
* [ ] Legacy rows without `recording_session_id` or `attempt_id` remain readable as read-only legacy provenance.
* [ ] Existing `stream_id=""` legacy readability is preserved and `"default"` remains frontend display-only.
* [ ] `highest_contiguous_accepted_seq` is used for final sequence correctness; a received higher sequence cannot hide a missing middle sequence.
* [ ] `stream.stop` carries `stream_id`, `final_seq`, `recording_session_id`, `attempt_id`, and `terminal_reason`.
* [ ] `stream.unavailable` is used only before a stream starts and its ACK omits `final_seq` while echoing `terminal_reason`.
* [ ] `stream.terminal_ack` confirms control acceptance only; it does not imply STT, persistence, stream finalization, meeting finalization, analysis start, or analysis completion.
* [ ] Every terminal ACK echoes `terminal_reason`.
* [ ] Accepted `stream.stop` reports `stream_state=FINALIZING`, not `FINALIZED`.
* [ ] Exact duplicate controls return `accepted=true` and `IDEMPOTENT_REPLAY`.
* [ ] Incompatible controls return `TERMINAL_CONTROL_CONFLICT`.
* [ ] Backend finalizes only after contiguous acceptance through `final_seq` or a bounded gap policy reaches terminal failure.
* [ ] Backend rejects `seq > final_seq` after accepted stop and all audio after accepted unavailable without erasing valid durable transcript.
* [ ] Global FIFO and atomic metadata-binary pair no-interleaving are enforced for each WebSocket connection.
* [ ] All expected streams reach terminal stream state before meeting terminal closure.
* [ ] `T_server_control_accepted(stream_id)`, `T_server_transport_terminalized(stream_id)`, and `T_server_meeting_terminal_anchor` are distinct.
* [ ] `T_server_meeting_terminal_anchor` exists for accepted terminal controls and socket-close/inactivity transport fallback.
* [ ] Backend transcript and analysis operational metrics are anchored to `T_server_meeting_terminal_anchor`.
* [ ] The server terminal anchor never replaces frontend `T_user_stop` SLA.
* [ ] One stream with non-blank durable transcript preserves `analysis_eligible=true` despite failure, finalization, reconciliation, timeout, replacement, or unavailability of another stream.
* [ ] Reconciliation responses echo `meeting_id`, `recording_session_id`, `attempt_id`, and monotonic `status_version`.
* [ ] Realtime and hydration responses include `meeting_id`, `recording_session_id`, `attempt_id`, `status_version`, and `authoritative_at`; their stale scope is `meeting_id + recording_session_id + attempt_id`.
* [ ] Analysis polling responses include `meeting_id`, `recording_session_id`, `analysis_request_id`, `analysis_status_version`, `authoritative_at`, `current_attempt_id`, `origin_attempt_id`, and `included_attempt_ids`; their stale scope is `meeting_id + recording_session_id + analysis_request_id`.
* [ ] FE drops realtime/hydration responses only on mismatched realtime identity or lower `status_version` for that tuple.
* [ ] FE drops analysis polling responses only on mismatched analysis-job identity or lower `analysis_status_version` for that job; `status_version` and attempt provenance never order analysis responses.
* [ ] A valid analysis result is not discarded solely because reconnect changed current attempt provenance.
* [ ] Equal `status_version` and equal `analysis_status_version` are idempotent and cannot regress visible state.
* [ ] `STALE_STATUS_QUERY` is rejected or clearly marked and cannot overwrite current UI.
* [ ] Missing meeting remains a real not-found result.
* [ ] `analysis_status=NOT_STARTED` may coexist with `analysis_eligible=true`.
* [ ] `NOT_READY` maps conditionally, not universally, to `PENDING`.
* [ ] Existing meeting with no analysis row returns `NOT_STARTED`; a missing meeting remains a real not-found result.
* [ ] Analysis eligibility may become true before all expected streams have terminal evidence.
* [ ] Analysis job creation, execution, and analysis_input_cutoff are governed by Section 9.4 Rules 4–7. T_server_meeting_terminal_anchor is necessary but not sufficient; every expected stream must also reach terminal outcome after chunk drain and STT/persistence finalization.
* [ ] Accepted `stream.stop` alone does not create `analysis_input_cutoff` or an analysis job.
* [ ] At transcript deadline, unresolved expected streams are authoritatively reconciled to `FINALIZED`, `UNAVAILABLE`, `FAILED`, `TIMED_OUT`, or `REPLACED`; unavailable authoritative state yields `SESSION_TERMINAL_FAILED`, no cutoff, and no analysis job.
* [ ] No active automatic analysis job is checked by `meeting_id + recording_session_id` before `analysis_request_id` is created.
* [ ] Exactly one `analysis_request_id`, immutable analysis input cutoff, immutable input snapshot, and analysis job state are created atomically when no active automatic job exists.
* [ ] Existing analysis jobs are scoped to `meeting_id + recording_session_id + analysis_request_id`.
* [ ] `attempt_id` is preserved as segment provenance and is not the sole identity of the analysis job.
* [ ] Analysis input snapshot/cutoff is immutable and includes only non-blank durable segments from the current `recording_session_id`.
* [ ] Valid durable transcript from replaced prior attempts in the same recording session may be included with attempt provenance.
* [ ] Segments from another `recording_session_id` never enter the snapshot.
* [ ] Reconnect after analysis creation does not mutate, cancel, or duplicate the active analysis job automatically.
* [ ] Late durable transcript remains persisted and visible but never mutates active analysis or creates an automatic duplicate job.
* [ ] `analysis_request_id`, `analysis_input_cutoff_at`, `included_attempt_ids`, and `late_transcript_after_cutoff` are exposed where applicable.
* [ ] Backend operational analysis deadline uses `min(T_server_meeting_terminal_anchor + 57 seconds, analysis_input_cutoff_at + 40 seconds)`.
* [ ] Backend does not compare its clock directly with frontend monotonic `T_user_stop`.
* [ ] Analysis retries are server-owned; FE only polls and never submits duplicate analysis work.
* [ ] `RETRYABLE_FAILED` is not a terminal user-facing result and cannot remain at server/frontend terminal deadlines.
* [ ] Frontend and backend terminal analysis duration metrics end only at `SUCCEEDED` or `FAILED`.
* [ ] Required metrics include `frontend_stop_to_control_dispatch_ms`, `frontend_stop_ack_latency_ms`, `frontend_stop_to_transcript_ms`, `frontend_stop_to_analysis_terminal_ms`, `backend_meeting_terminal_anchor_to_transcript_ms`, `backend_meeting_terminal_anchor_to_analysis_terminal_ms`, `terminal_control_accept_latency_ms`, `analysis_input_cutoff_late_segments_total`, `stream_transport_timeout_total`, `stale_status_query_total`, and `runtime_provenance_collision_total`.
* [ ] Required metrics are emitted as values with no high-cardinality labels and no sensitive content.
* [ ] No metric label contains `meeting_id`, `recording_session_id`, `attempt_id`, `segment_id`, `trace_id`, `user_id`, transcript text, or raw audio.
* [ ] No logs contain transcript text, raw audio, tokens, cookies, API keys, authorization headers, passwords, provider secrets, or raw analysis input.
* [ ] Mandatory Markdown/document integrity, protocol, lifecycle, provenance, queue, transport, terminal-anchor, reconciliation, stale-envelope, analysis, ai-api, frontend, and browser smoke tests are implemented and included in release gating.
* [ ] Chrome and Edge Windows browser smoke matrix is completed and release-reviewed.
* [ ] `analysis_input_cutoff` is not created merely because `stream.stop` was accepted. It is created only after Section 9.4 Rules 4–7 are satisfied; if authoritative state cannot be obtained by reconciliation deadline, `SESSION_TERMINAL_FAILED` is returned and no analysis job is created.
