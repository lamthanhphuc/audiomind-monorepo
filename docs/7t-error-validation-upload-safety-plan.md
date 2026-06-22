---
title: "7T — Error, Validation & Upload Safety — Implementation Plan"
status: DRAFT
updated: 2026-06-22
branch: fix/error-validation-upload-safety
---

## Overview

Plan này chia theo **TDD slices** (mỗi slice: test → implement → refactor). Epic 2 là P0 nên ưu tiên:

- `no regression` cho upload, realtime, analysis hiện có
- rollout có **feature flag theo slice**
- observability đủ để rollback nhanh
- một **contract file** làm source of truth cho validation policy thay vì chỉ inventory bằng doc

## Task Breakdown (TDD slices)

### Slice 1 — Validation contract source-of-truth (doc + artifact)
- **Goal**: Tạo một artifact dùng chung làm chuẩn cho upload/realtime validation policy.
- **Deliverables**:
  - `docs/contracts/upload-validation-policy.yaml` hoặc `packages/contracts/upload-validation-policy.json`
  - fields tối thiểu:
    - `maxUploadBytes`
    - `allowedExtensions`
    - `allowedMimeTypes`
    - `realtime.maxChunkBytes`
    - `realtime.allowedContainer`
    - `realtime.allowedCodec`
  - baseline inventory được fold vào artifact thay vì giữ thành slice độc lập thuần doc
- **Policy baseline đề xuất (P0)**:
  - `maxUploadBytes = 104857600` (100MB)
  - `allowedExtensions = [.mp3, .wav, .m4a]`
  - `realtime.maxChunkBytes = 1048576` (1MB)
  - `realtime.allowedContainer = webm`
  - `realtime.allowedCodec = opus`
- **Feature flag**: none
- **Rollback plan**: N/A, đây là artifact nền tảng, không đổi runtime behavior một mình.
- **Tests**:
  - contract schema validation test
  - snapshot test cho artifact để tránh drift ngoài ý muốn

### Slice 2 — Unified error schema + traceId propagation (HTTP)
- **Goal**: Mọi service HTTP trả payload lỗi thống nhất + luôn có `x-trace-id`.
- **Work**:
  - Java: chuẩn hoá `ApiErrorResponse` fields + ensure `TraceIdFilter` always sets MDC and response header.
  - Python: thống nhất error payload (FastAPI exception handlers) để luôn có `traceId`, `errorCode`.
  - FE: hiển thị `traceId` trong `ErrorState` / upload failure UI.
  - Chuẩn payload bổ sung trường `details.cta` khi phù hợp.
- **Feature flag**: `ERROR_UX_ENABLED`
- **Rollback plan**:
  - nếu `ERROR_UX_ENABLED=false`, services vẫn trả baseline payload hiện tại; FE fallback về render `ApiError.message` + `traceId` nếu có, không phụ thuộc `cta`.
- **Tests**:
  - Java `GlobalExceptionHandlerTest` for trace header + body
  - Python unit tests for error handler payload
  - FE component tests verify traceId rendering
  - **Integration tests**:
    - upload invalid request trả `errorCode`, `message`, `traceId`, `path`
    - unauthorized/forbidden response vẫn có `x-trace-id`

### Slice 3 — Error message Vietnamese catalog + CTA mapping (P0 codes)
- **Goal**: `errorCode` P0 map ra message tiếng Việt + CTA id, không leak message kỹ thuật.
- **Work**:
  - Java: replace defaultMessage English → Vietnamese for P0.
  - Python: normalize default error messages cho P0 thay vì đẩy message kỹ thuật ra ngoài.
  - FE: CTA mapping table (e.g. “chọn file khác”, “thử lại”, “đăng nhập lại”, “giảm dung lượng file”).
- **Dependencies**: phụ thuộc Slice 2.
- **Feature flag**: `ERROR_UX_ENABLED`
- **Rollback plan**:
  - nếu `ERROR_UX_ENABLED=false`, dùng lại message baseline hiện tại; code path mới không được đổi status code hay errorCode semantics.
- **Tests**:
  - snapshot-like tests for code→message mapping
  - FE render tests cho CTA theo `errorCode`
  - **Integration tests**:
    - invalid upload file → message VN đúng, CTA đúng
    - expired auth → CTA “đăng nhập lại”

### Slice 4 — Upload validation policy alignment (FE + meeting-service + processing + ai-service)
- **Goal**: Đồng bộ allowlist + maxBytes giữa services; FE preflight validate.
- **Work**:
  - Read policy từ contract file của Slice 1.
  - meeting-service: align allowed extensions + max bytes; return structured error codes.
  - ai-service: align max bytes; return `UPLOAD_TOO_LARGE`, `UPLOAD_UNSUPPORTED_FORMAT`.
  - processing-service: validate before forwarding (fail fast) + propagate error codes.
  - FE: UI “Định dạng hỗ trợ …” lấy từ config, không hardcode.
  - FE preflight validate size/ext trước khi gọi API.
- **Dependencies**:
  - phụ thuộc Slice 1 (contract file)
  - phụ thuộc Slice 2 (error schema)
  - hưởng lợi từ Slice 3 (VN message/CTA)
- **Feature flag**: `UPLOAD_VALIDATION_STRICT`
- **Rollback plan**:
  - nếu `UPLOAD_VALIDATION_STRICT=false`, runtime quay về baseline:
    - FE chỉ cảnh báo mềm hoặc dùng UI hiện tại
    - backend giữ rule hiện có theo từng service, không enforce strict policy chung
- **Tests**:
  - meeting-service upload tests (size/ext/filename)
  - ai-service upload tests (size/ext)
  - FE preflight tests
  - processing-service forwarding tests khi file invalid bị fail-fast
  - **Integration tests**:
    - upload `.exe` renamed `.mp3` vẫn bị reject ở lớp validation tương ứng
    - file > 100MB trả `UPLOAD_TOO_LARGE`
    - file hợp lệ pass qua meeting-service → processing-service → ai-service

### Slice 5 — MIME sniff + mismatch handling (best-effort)
- **Goal**: Chặn file “đổi đuôi” rõ ràng; không phụ thuộc antivirus.
- **Work**:
  - Java: dùng **Apache Tika** để sniff MIME / container.
  - Python: dùng **`python-magic`** để sniff MIME.
  - Nếu sniff library unavailable hoặc ambiguous:
    - log marker
    - fallback về extension allowlist
  - Error code: `UPLOAD_MIME_MISMATCH`.
  - Log markers:
    - `UPLOAD_VALIDATION_MIME_CHECKED`
    - `UPLOAD_VALIDATION_MIME_FALLBACK`
    - `MIME_MISMATCH`
- **Dependencies**:
  - phụ thuộc Slice 1 (policy)
  - phụ thuộc Slice 2 (error schema)
  - phụ thuộc Slice 4 (strict upload validation path)
- **Feature flag**: `MIME_SNIFF_ENABLED`
- **Rollback plan**:
  - nếu `MIME_SNIFF_ENABLED=false`, quay về validation bằng extension/size như Slice 4, không block upload chỉ vì chưa sniff được MIME.
- **Tests**:
  - unit tests using small byte fixtures.
  - Tika/magic adapter tests
  - **Integration tests**:
    - file extension hợp lệ nhưng bytes sai → `UPLOAD_MIME_MISMATCH`
    - sniff unavailable → upload dùng fallback path và log marker phù hợp

### Slice 6 — Realtime payload validation hardening
- **Goal**: reject sớm invalid/malicious payload với `REALTIME_*` error codes.
- **Work**:
  - processing-service websocket: enforce strict schema check cho `audio.chunk`.
  - ai-service stream endpoint: reject empty chunk, invalid seq, unsupported encoding.
  - **Policy P0**:
    - `chunk <= 1MB`
    - `codec = opus`
    - `container = webm`
  - FE hiện tại đang ghi `audio/webm; codecs=opus`; slice này chỉ formalize và enforce server-side.
  - Error codes:
    - `REALTIME_INVALID_PAYLOAD`
    - `REALTIME_CHUNK_TOO_LARGE`
    - `REALTIME_UNSUPPORTED_ENCODING`
  - Log markers:
    - `REALTIME_VALIDATION_FAILED`
    - `REALTIME_VALIDATION_ACCEPTED`
- **Dependencies**:
  - phụ thuộc Slice 1 (realtime policy)
  - phụ thuộc Slice 2 (error schema)
  - phụ thuộc Slice 3 cho message VN
- **Feature flag**: `REALTIME_VALIDATION_ENABLED`
- **Rollback plan**:
  - nếu `REALTIME_VALIDATION_ENABLED=false`, quay về baseline realtime acceptance path; chỉ giữ các guards cũ không thay đổi hành vi hiện tại.
- **Tests**:
  - MeetingWebSocketHandlerTest new cases
  - ai-service realtime endpoint tests
  - FE tests cho client-side guard nếu có
  - **Integration tests**:
    - chunk > 1MB bị reject có `traceId`
    - non-webm / non-opus bị reject
    - valid webm/opus chunk vẫn pass, không regression flow hiện có

### Slice 7 — Upload security scan hook (feature-flagged)
- **Goal**: có chỗ “plug-in” scan; default off nhưng log marker đầy đủ.
- **Work**:
  - Interface: `UploadSecurityScanner.scan(path, traceId)`.
  - Env flag `UPLOAD_SECURITY_SCAN_ENABLED`.
  - Implement “disabled scanner” + log markers.
  - Tích hợp **ClamAV** (hoặc dịch vụ scan tương tự) với fallback:
    - scanner unavailable → configurable fail-open/fail-closed policy
    - default P0: fail-open + log + metric, để tránh production lockout khi infra scan chưa ổn định
  - Log markers:
    - `UPLOAD_SCAN_SKIPPED`
    - `UPLOAD_SCAN_PASSED`
    - `UPLOAD_SCAN_FAILED`
    - `UPLOAD_SCAN_INFRA_ERROR`
- **Dependencies**:
  - phụ thuộc Slice 2 (structured errors)
  - phụ thuộc Slice 4 (upload path standardized)
- **Feature flag**: `UPLOAD_SECURITY_SCAN_ENABLED`
- **Rollback plan**:
  - nếu `UPLOAD_SECURITY_SCAN_ENABLED=false`, scanner path bị bypass hoàn toàn và behavior quay về baseline upload validation của Slice 4/5.
- **Tests**:
  - unit tests ensure scan called/ skipped based on flag
  - mock ClamAV adapter tests
  - **Integration tests**:
    - infected/suspicious fixture (mocked scanner verdict) → reject with errorCode phù hợp
    - scanner infra error + fail-open policy → upload tiếp tục nhưng có log marker

### Slice 8 — Observability + smoke scripts
- **Goal**: dễ triage lỗi upload và realtime.
- **Work**:
  - log markers + grep patterns in `scripts/log-bundle.sh`
  - append grep patterns:
    - `UPLOAD_VALIDATION_*`
    - `MIME_MISMATCH`
    - `REALTIME_VALIDATION_*`
    - `UPLOAD_SCAN_*`
  - docs deploy checklist append Epic 2
- **Dependencies**: nên đi sau Slice 4–7 để pattern phản ánh hành vi thật.
- **Feature flag**: none
- **Rollback plan**:
  - nếu chưa rollout runtime slice tương ứng, script vẫn có thể grep no-op; không ảnh hưởng production behavior.
- **Tests**:
  - script smoke test với sample log bundle
  - docs review checklist

## Feature Flags

| Flag | Slice | Default rollout stance | Disable effect |
| --- | --- | --- | --- |
| `ERROR_UX_ENABLED` | 2, 3 | on in staging first | revert về baseline payload/message rendering |
| `UPLOAD_VALIDATION_STRICT` | 4 | off -> stage -> on | revert về per-service validation baseline |
| `MIME_SNIFF_ENABLED` | 5 | off by default initially | skip sniff; rely on size/ext only |
| `REALTIME_VALIDATION_ENABLED` | 6 | off -> shadow logs -> on | revert về current realtime acceptance path |
| `UPLOAD_SECURITY_SCAN_ENABLED` | 7 | off until infra ready | bypass security scanner path |

## Dependencies

### Services / libraries

- `meeting-service`
- `processing-service`
- `ai-service`
- FE (`FE-Audiomind`)
- contract artifact (JSON/YAML)
- Java MIME sniff: **Apache Tika**
- Python MIME sniff: **python-magic**
- Upload scan: **ClamAV** or equivalent scanning service

### Slice dependency graph

```text
Slice 1 (contract file)
  -> Slice 4 (upload validation alignment)
  -> Slice 5 (MIME sniff policy)
  -> Slice 6 (realtime validation policy)

Slice 2 (error schema + traceId)
  -> Slice 3 (VN message + CTA)
  -> Slice 4 (structured upload errors)
  -> Slice 6 (structured realtime errors)
  -> Slice 7 (structured scan errors)

Slice 4
  -> Slice 5
  -> Slice 7

Slices 4/5/6/7
  -> Slice 8 (observability + smoke scripts)
```

## Risk & Mitigation

- **Regression upload**: bật feature flags theo stage; cover by integration tests.
- **False negative MIME sniff**: best-effort + fallback to extension allowlist; log for tuning.
- **False positive MIME sniff**: rollout `MIME_SNIFF_ENABLED` sau khi có fixture matrix thực tế.
- **Realtime strictness too early**: bật `REALTIME_VALIDATION_ENABLED` ở mode logging-first/shadow validation trước nếu cần.
- **Scanner infra flaky**: fail-open mặc định ở P0, có log + metric để theo dõi.
- **Localization creep**: chỉ P0 codes; non-goals: full i18n framework.

## Rollback Plan

Rollback ưu tiên bằng **feature flag**, không rollback code ngay nếu không cần:

1. Nếu lỗi UX mới gây nhiễu: `ERROR_UX_ENABLED=false`
2. Nếu strict upload block quá nhiều file hợp lệ: `UPLOAD_VALIDATION_STRICT=false`
3. Nếu sniff gây false positive: `MIME_SNIFF_ENABLED=false`
4. Nếu realtime strict validation làm drop stream hợp lệ: `REALTIME_VALIDATION_ENABLED=false`
5. Nếu scan infra lỗi / timeout: `UPLOAD_SECURITY_SCAN_ENABLED=false`

Expected rollback behavior:

- hệ thống quay về baseline validation/error path trước Epic 2
- không đổi auth/model/business logic hiện hữu
- observability markers vẫn giữ nếu an toàn, để hỗ trợ postmortem

## Estimated Timeline

- 0.5d: Slice 1
- 0.5–1d: Slices 2–3
- 1–2d: Slice 4 (alignment + FE preflight)
- 1d: Slice 5
- 1d: Slice 6
- 0.5–1d: Slice 7
- 0.5d: Slice 8

