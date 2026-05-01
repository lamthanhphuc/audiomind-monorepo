# ADR-0001: Modular Monorepo + Clean Architecture

## Status
Accepted

## Context
He thong gom:
- meeting-service (metadata, lifecycle)
- processing-service (orchestration)
- ai-service (AI pipeline + celery)
- whisper-service, diarization-service (STT/diarization)

Yeu cau:
- Scale AI doc lap, tach tai nguyen GPU/CPU
- Duy tri boundary ro rang giua cac service
- Trace end-to-end cho chuoi xu ly meeting

## Decision
Chon:
- Modular Monorepo cho toan bo service
- Clean Architecture per service (controller -> service -> repository)
- Contract tap trung trong packages/contracts
- Giao tiep service-to-service uu tien gRPC (binary, streaming) cho low-latency path; browser-facing APIs use REST + WebSocket for realtime push

## Consequences

### Positive
- Boundary ro rang, de quan ly quyen truy cap
- Contract centralized, giam drift
- Trace end-to-end de dong bo log/metrics

### Negative
- Can enforce CI/quality gate manh
- Setup ban dau phuc tap hon

## Rules

1. Khong cross-database access giua service.
2. Giao tiep chi qua:
   - OpenAPI (sync)
   - Event schema (async)
3. Moi service tuan thu clean layers, controller khong nhung business rules.

## Alternatives Considered

### Monolith
- Khong scale tot AI pipeline va GPU workload.

### Multi-repo
- Contract drift, kho dong bo trace.

## References
- /docs/architecture/*
