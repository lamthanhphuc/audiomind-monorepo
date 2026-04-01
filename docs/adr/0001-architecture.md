# ADR-0001: Modular Monorepo + Clean Architecture

## Status
Accepted

## Context
He thong gom:
- meeting-api (metadata, lifecycle)
- processing-api (orchestration)
- ai-api (AI pipeline)

Yeu cau:
- scale AI doc lap
- maintain de
- AI agent doc/trace de

## Decision
Chon:
- Modular Monorepo
- Clean Architecture per service

## Consequences

### Positive
- Boundary ro rang
- Contract centralized
- AI agent trace end-to-end de

### Negative
- Can enforce CI manh
- Setup ban dau phuc tap hon

## Rules

1. Khong cross-database access
2. Giao tiep chi qua:
   - OpenAPI (sync)
   - Event schema (async)
3. Moi service tuan thu clean layers

## Alternatives Considered

### Monolith
- Khong scale tot AI pipeline

### Multi-repo
- Drift contract + kho trace

## References
- /docs/architecture/*
