# Realtime WebSocket: Dual-stream Tab + Mic

## auth.init

```json
{
  "type": "auth.init",
  "token": "...",
  "meetingId": 10,
  "language": "vi",
  "speakerMode": "multiple",
  "dualStream": true,
  "activeStreams": ["tab", "mic"]
}
```

- `dualStream`: required for dual mode (FE + backend flag ON)
- `activeStreams`: subset of `tab`, `mic`; omit mic when unavailable

## audio.chunk metadata

```json
{
  "type": "audio.chunk",
  "meeting_id": 10,
  "stream_id": "tab",
  "seq": 1,
  "ts_ms": 1710000000000,
  "sample_rate": 48000,
  "channels": 1,
  "encoding": "webm-opus",
  "mime_type": "audio/webm",
  "size": 4096,
  "recording_session_id": 1,
  "attempt_id": 1
}
```

Binary frame **immediately follows** metadata for the same `stream_id` + `seq`.

## stream.stop

```json
{ "type": "stream.stop" }
```

Processing drains async queue, finalizes each active stream with `seq=-1`, merges transcripts, triggers analysis once.

## Transcript events

Partial/final events include `streamId` when dual mode is active.

## Backward compatibility

No `stream_id` → legacy single-stream (`stream_id=""`).
