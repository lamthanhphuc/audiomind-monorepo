# Processing State Machine

## States
- PENDING
- PROCESSING
- RETRYING
- COMPLETED
- FAILED

## Transitions

| From       | To         | Condition             |
|------------|------------|-----------------------|
| PENDING    | PROCESSING | job accepted          |
| PROCESSING | COMPLETED  | success               |
| PROCESSING | RETRYING   | retryable error       |
| RETRYING   | PROCESSING | retry attempt         |
| RETRYING   | FAILED     | max attempts exceeded |
| PROCESSING | FAILED     | non-retryable error   |

## Requirements (Mandatory)

Each transition MUST:
1. Emit structured log
2. Emit metric
3. (If async) emit event

## Retry Policy

- strategy: exponential backoff
- max_attempts: configurable
- idempotency_key: required

## Events (Phase 2)

- processing-started
- processing-retrying
- processing-completed
- processing-failed
