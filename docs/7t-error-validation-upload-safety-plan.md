---
title: "7T — Error, Validation & Upload Safety — Implementation Plan"
status: DRAFT
updated: 2026-06-22
branch: fix/error-validation-upload-safety
---

## Overview

Plan này chia theo **TDD slices** (mỗi slice: test → implement → refactor). Epic 2 là P0 nên ưu tiên “no regression”, rollout có flag, và observability đủ để rollback nhanh.

## Task Breakdown (TDD slices)

### Slice 1 — Baseline contract inventory (no runtime change)
- **Goal**: Chốt danh sách endpoints upload/realtime + current limits (bytes, extensions) + error payload shapes.
- **Deliverables**:
  - doc section “Current Baseline” hoàn chỉnh trong spec
  - contract checklist (FE ↔ services)
- **Tests**: none (doc-only)

### Slice 2 — Unified error schema + traceId propagation (HTTP)
- **Goal**: Mọi service HTTP trả payload lỗi thống nhất + luôn có `x-trace-id`.
- **Work**:
  - Java: chuẩn hoá `ApiErrorResponse` fields + ensure `TraceIdFilter` always sets MDC and response header.
  - Python: thống nhất error payload (FastAPI exception handlers) để luôn có `traceId`, `errorCode`.
  - FE: hiển thị `traceId` trong `ErrorState` / upload failure UI.
- **Tests**:
  - Java `GlobalExceptionHandlerTest` for trace header + body
  - Python unit tests for error handler payload
  - FE component tests verify traceId rendering

### Slice 3 — Error message Vietnamese catalog + CTA mapping (P0 codes)
- **Goal**: `errorCode` P0 map ra message tiếng Việt + CTA id, không leak message kỹ thuật.
- **Work**:
  - Java: replace defaultMessage English → Vietnamese for P0.
  - FE: CTA mapping table (e.g. “chọn file khác”, “thử lại”, “đăng nhập lại”).
- **Tests**:
  - snapshot-like tests for code→message mapping

### Slice 4 — Upload validation policy alignment (FE + meeting-service + processing + ai-service)
- **Goal**: Đồng bộ allowlist + maxBytes giữa services; FE preflight validate.
- **Work**:
  - Define single source of truth (contract json file or env-backed config endpoint).
  - meeting-service: align allowed extensions + max bytes; return structured error codes.
  - ai-service: align max bytes; return `UPLOAD_TOO_LARGE`, `UPLOAD_UNSUPPORTED_FORMAT`.
  - processing-service: validate before forwarding (fail fast) + propagate error codes.
  - FE: UI “Định dạng hỗ trợ …” lấy từ config, không hardcode.
- **Tests**:
  - meeting-service upload tests (size/ext/filename)
  - ai-service upload tests (size/ext)
  - FE preflight tests

### Slice 5 — MIME sniff + mismatch handling (best-effort)
- **Goal**: Chặn file “đổi đuôi” rõ ràng; không phụ thuộc antivirus.
- **Work**:
  - Java: sniff magic bytes cho mp3/wav/m4a (heuristic).
  - Python: optional sniff; nếu không sniff được thì rely ext allowlist.
  - Error code: `UPLOAD_MIME_MISMATCH`.
- **Tests**:
  - unit tests using small byte fixtures.

### Slice 6 — Realtime payload validation hardening
- **Goal**: reject sớm invalid/malicious payload với `REALTIME_*` error codes.
- **Work**:
  - processing-service websocket: enforce max message/chunk size + strict schema check
  - ai-service stream endpoint: enforce max bytes, reject empty, validate seq
- **Tests**:
  - MeetingWebSocketHandlerTest new cases
  - ai-service realtime endpoint tests

### Slice 7 — Upload security scan hook (feature-flagged)
- **Goal**: có chỗ “plug-in” scan; default off nhưng log marker đầy đủ.
- **Work**:
  - Interface: `UploadSecurityScanner.scan(path, traceId)`.
  - Env flag `UPLOAD_SECURITY_SCAN_ENABLED`.
  - Implement “disabled scanner” + log markers.
  - (Optional later) ClamAV client integration nếu infra sẵn.
- **Tests**:
  - unit tests ensure scan called/ skipped based on flag

### Slice 8 — Observability + smoke scripts
- **Goal**: dễ triage lỗi upload và realtime.
- **Work**:
  - log markers + grep patterns in `scripts/log-bundle.sh`
  - docs deploy checklist append Epic 2
- **Tests**: N/A (scripts + docs)

## Dependencies

- Services: `meeting-service`, `processing-service`, `ai-service`, FE (`FE-Audiomind`).
- Shared contract artifact (json/yaml) hoặc config endpoint.
- Optional: ClamAV daemon (nếu làm Phase 2).

## Risk & Mitigation

- **Regression upload**: bật feature flags theo stage; cover by integration tests.
- **False negative MIME sniff**: best-effort + fallback to extension allowlist; log for tuning.
- **Localization creep**: chỉ P0 codes; non-goals: full i18n framework.

## Estimated Timeline

- 0.5–1d: slices 1–3
- 1–2d: slice 4 (alignment + FE preflight)
- 1d: slice 5
- 1d: slice 6
- 0.5d: slice 7 (hook + logs)
- 0.5d: slice 8

