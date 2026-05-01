# Processing State Machine

## States
- PENDING
- PROCESSING
- PARTIAL
- RECONNECTING
- DEGRADED
- RETRYING
- COMPLETED
- FAILED

## Transitions

| From       | To         | Condition             |
|------------|------------|-----------------------|
| PENDING    | PROCESSING | job accepted          |
| PROCESSING | PARTIAL    | first partial transcript/event emitted |
| PARTIAL    | PARTIAL    | additional partial transcript/events |
| PARTIAL    | PROCESSING | stream stabilized and partial window closed |
| PROCESSING | RECONNECTING | websocket/grpc stream interrupted but recoverable |
| RECONNECTING | PARTIAL  | stream resumed and partial events continue |
| RECONNECTING | DEGRADED | reconnect exceeded threshold or repeated transient errors |
| DEGRADED   | PROCESSING | fallback path recovered (batch/polling or stable stream) |
| DEGRADED   | FAILED     | unrecoverable error while degraded |
| PROCESSING | COMPLETED  | success               |
| PROCESSING | RETRYING   | retryable error       |
| RETRYING   | PROCESSING | retry attempt         |
| RETRYING   | FAILED     | max attempts exceeded |
| PROCESSING | FAILED     | non-retryable error   |
| PARTIAL    | FAILED     | stream error not recoverable |

## Requirements (Mandatory)

Each transition MUST:
1. Emit structured log
2. Emit metric
3. (If async) emit event

## Retry Policy

- strategy: exponential backoff
- max_attempts: configurable
- idempotency_key: required

## Streaming State Notes

- `PARTIAL`: active streaming mode, transcript or keyword events are being emitted incrementally.
- `RECONNECTING`: transient network/channel disruption; service attempts automatic reconnect.
- `DEGRADED`: streaming quality reduced or fallback mode is active; system may continue with polling/batch path.

Suggested triggers:
- Move to `RECONNECTING` after connection close/error and retry budget remains.
- Move to `DEGRADED` when reconnect attempts exceed threshold or lag/event loss crosses safety limits.
- Move from `DEGRADED` back to `PROCESSING` only after health and ordering checks pass.

## Events (Phase 2)

- processing-started
- processing-partial
- processing-reconnecting
- processing-degraded
- processing-retrying
- processing-completed
- processing-failed
