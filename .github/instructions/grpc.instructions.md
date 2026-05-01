---
description: "Use when: creating or modifying protobuf contracts, gRPC services, or streaming RPC logic."
name: "gRPC Protobuf Guidelines"
applyTo:
  - packages/contracts/**/*.proto
  - "**/*grpc*"
---
# gRPC / Protobuf Guidelines

## Versioning and Compatibility
- Keep proto changes backward compatible whenever possible.
- Do not reuse or renumber existing field numbers.
- Mark removed fields as reserved when needed.
- Avoid breaking message shape for existing consumers without migration plan.

## Naming Conventions
- Service names: clear domain-focused names (e.g., `AiStreamService`).
- RPC names: verb-oriented (`ProcessMeeting`, `StreamAudio`).
- Message names: noun/event-oriented with explicit meaning (`AudioChunk`, `TranscriptPartialEvent`).

## Streaming RPC Rules
- Keep bidirectional stream contracts explicit and documented.
- Define event envelope/message contracts for stream payloads.
- Handle reconnect and partial delivery semantics in consumer design.
- Include trace/correlation IDs where possible.

## Code Generation Guidance
- Keep generated code in sync with proto source updates.
- Regenerate stubs/clients in the same change when contracts are updated.
- Validate downstream compile/test after regeneration.

## Validation Before Finish
- Run OpenAPI/schema/contract checks where relevant.
- Verify touched service tests pass for stream and non-stream paths.
