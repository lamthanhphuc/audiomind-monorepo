# ADR: Dual-stream STT for Tab + Microphone

## Status

Accepted

## Context

`browser_tab_with_mic` previously mixed tab and microphone into one WebM stream (hard gate). Tab audio dominated STT; mic required repeated speech; Deepgram diarization could not distinguish tab vs mic sources.

## Decision

When `browser_tab_with_mic` and feature flags are enabled, send **two parallel STT streams** on one WebSocket:

| Field | Value |
|-------|-------|
| `stream_id` | `tab` or `mic` |
| `seq` | Per-stream monotonic from 1 |
| Actor key | `{meeting_id}:{stream_id}` |
| Speakers | `TAB_SPEAKER_*`, `MIC_SPEAKER_*` |

Legacy single-stream mode uses `stream_id=""` (omitted).

## Finalize gate

Meeting analysis runs only after **all active streams** receive synthetic final chunk (`seq=-1`).

| Condition | Policy |
|-----------|--------|
| `AUDIO_RECEIVED` | OR across active streams |
| `isInvalidAudioCapture` | Per-stream; fail only if all active streams invalid |
| `micIncluded=false` | `activeStreams=['tab']` only |
| `RESET_REQUIRED` | Skip finalize `-1`; no analysis |

## Quota

Each binary chunk calls `enforceRealtimeSttQuota` independently (~2× STT when both streams active).

## Recovery

On `RESET_REQUIRED`, FE aborts and restarts **both** recorders; resets per-stream seq.

## Feature flags

All three must be ON for dual mode:

- `REALTIME_DUAL_STREAM_TAB_MIC_ENABLED` (processing + ai-service)
- `VITE_REALTIME_DUAL_STREAM_TAB_MIC` (FE)

## References

- [realtime-ws-dual-stream.md](../specs/realtime-ws-dual-stream.md)
- [ADR-0001](0001-architecture.md)
