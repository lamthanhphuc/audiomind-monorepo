---
title: "7T — Error, Validation & Upload Safety Spec"
status: SPEC-ONLY
scope: "Epic 2 (P0): ErrorUX-A, Validation-A, Security-D, Upload Validation"
updated: 2026-06-22
branch: fix/error-validation-upload-safety
---

## 1. Executive Summary

Epic 2 **Error + Validation + Upload Safety (P0)** tập trung vào:

- **ErrorUX-A**: Chuẩn hoá lỗi end-to-end (server → client) với `errorCode`, `traceId`, thông điệp **tiếng Việt**, và **CTA** (hành động khuyến nghị).
- **Validation-A**: Validate đầu vào realtime + upload theo rule thống nhất (MIME/type, size, format/container, filename).
- **Security-D**: Nâng mức an toàn upload (quyền truy cập, chống path traversal, hạn chế file type, scan/heuristics, rate/abuse guard).
- **Upload Validation**: Đồng bộ rule **client/server** để giảm lỗi “FE cho chọn nhưng BE reject” hoặc ngược lại.

Không sửa hoặc thay đổi logic sản phẩm ngoài phạm vi trên; ưu tiên **không regression**.

---

## 2. Current Production Baseline (code-grounded)

### 2.1 Error payload + trace headers

- **Java services** (`meeting-service`, `processing-service`, `user-service`) có `GlobalExceptionHandler` trả về `ApiErrorResponse` gồm:
  - `errorCode`, `message`, `status`, `timestamp`, `traceId`, `path`, `details`.
  - Response header: `x-trace-id` (qua `TraceIdFilter.TRACE_HEADER`).
- **FE** (`FE-Audiomind/src/services/api.ts`) parse lỗi:
  - đọc `x-trace-id` hoặc `x-request-id` từ response headers và ném `ApiError(message, status, traceId, errorCode, retryAfterSeconds)`.
- **Python ai-service** (FastAPI) có handler tự dựng payload lỗi (và sanitize) ở `demoRecordAUDIOMID/ai-service/app/main.py`.

### 2.2 Upload validation hiện tại (gap rõ)

- **Meeting upload** (`meeting-service/MeetingController.upload`):
  - giới hạn size: `MAX_UPLOAD_BYTES = 100MB`.
  - validate extension theo allowlist (nhiều hơn FE UI).
  - chống `..` trong tên file và guard path normalization.
  - **Chưa có** sniff MIME / container signature; không scan malware.
- **Processing upload** (`processing-service/ProcessingController.upload`) nhận `MultipartFile` rồi forward sang `ai-service` (qua `AIServiceClient.uploadAudio`).
- **AI upload** (`ai-service /api/upload-audio`):
  - validate extension theo `settings.allowed_upload_extensions`.
  - giới hạn size theo `settings.max_upload_size_bytes` (default 512MB).
  - **Chưa** validate `Content-Type`, container signature, hoặc decode sanity (ffmpeg probe) trước khi lưu.

### 2.3 Realtime input validation

- Realtime WebSocket handler và ai-service realtime endpoints có kiểm soát một số metadata/session, nhưng chưa có “shared validation contract” (chunk size limit, mime/type enforcement) dùng chung.

---

## 3. Problem Statement

### 3.1 User-facing issues

- Lỗi từ backend/FE chưa nhất quán tiếng Việt; đôi lúc message mang tính kỹ thuật/tiếng Anh; thiếu CTA rõ ràng.
- User gặp lỗi upload/realtime thường không biết “làm gì tiếp” (thử lại, đổi file, giảm dung lượng, đổi trình duyệt…).

### 3.2 Engineering issues

- Rule upload **không đồng bộ**:
  - FE UI hiển thị hỗ trợ `.mp3, .wav, .m4a` nhưng backend allow nhiều loại hơn / hoặc reject theo nơi khác nhau.
  - `meeting-service` limit 100MB nhưng `ai-service` default 512MB → inconsistent errors.
- Thiếu **defense-in-depth**:
  - MIME sniff/container probe, filename policy thống nhất, scan/heuristics tối thiểu.

---

## 4. Non-Goals

- Không làm hệ thống billing/quota mới.
- Không làm UI redesign lớn; chỉ thêm UX error/CTA cần thiết.
- Không thay provider STT/AI.
- Không làm auth model mới; chỉ siết validation/guard.
- Không triển khai antivirus server thật nếu infra chưa có; spec định nghĩa chế độ “optional + feature flag”.

---

## 5. Architecture Decision

### 5.1 Unified Error Contract (server → FE)

**Chuẩn payload lỗi** (tất cả services HTTP):

```json
{
  "errorCode": "UPLOAD_UNSUPPORTED_FORMAT",
  "message": "File không đúng định dạng hỗ trợ. Vui lòng chọn .mp3, .wav hoặc .m4a.",
  "status": 415,
  "timestamp": "ISO-8601",
  "traceId": "uuid-or-hex",
  "path": "/processing/upload",
  "details": {
    "cta": "select_supported_file",
    "maxBytes": 104857600,
    "allowedExtensions": [".mp3",".wav",".m4a"]
  }
}
```

**Headers**:
- Request: FE gửi `x-trace-id` cho mọi request (nếu chưa có).
- Response: backend luôn trả `x-trace-id` và (optional) `x-request-id`.

### 5.2 Shared Validation Policy

Tạo một “policy” thống nhất (dùng ở FE + Java + Python):

- Allowed extensions (MVP): `.mp3`, `.wav`, `.m4a` (có thể mở rộng sau).
- Max upload bytes (MVP): 100MB (khớp `meeting-service` hiện tại), và các service khác phải align.
- Allowed MIME (best-effort): `audio/mpeg`, `audio/wav`, `audio/x-wav`, `audio/mp4`, `audio/aac`, `audio/webm` (tuỳ container).
- Filename constraints: no path separators, no `..`, normalize unicode, length limit.
- Content validation:
  - (MVP) **sniff header**/magic bytes ở Java/Python (best-effort).
  - (Phase 2) ffmpeg probe/decoding preflight theo feature flag.

### 5.3 Upload Security layers

- **Authorization**: upload must require authenticated principal; validate ownership/meeting scope where applicable.
- **Rate/abuse guard** (MVP): simple per-user or per-IP limit (nếu có sẵn infra); nếu chưa, document as follow-up.
- **Malware scan**:
  - MVP: “pluggable” interface + feature flag. Nếu không có daemon (ClamAV), implement chế độ `scan=disabled` nhưng **log marker**.

---

## 6. ErrorUX-A — Error Standardization

### 6.1 Error codes (P0)

Nhóm upload:
- `UPLOAD_EMPTY_FILE`
- `UPLOAD_TOO_LARGE`
- `UPLOAD_UNSUPPORTED_FORMAT`
- `UPLOAD_INVALID_FILENAME`
- `UPLOAD_MIME_MISMATCH`
- `UPLOAD_SECURITY_SCAN_FAILED`

Nhóm realtime:
- `REALTIME_INVALID_PAYLOAD`
- `REALTIME_CHUNK_TOO_LARGE`
- `REALTIME_UNSUPPORTED_ENCODING`

Nhóm auth:
- `UNAUTHORIZED`
- `FORBIDDEN`

### 6.2 Vietnamese message catalog + CTA mapping

Mỗi `errorCode` có:
- **VN message** (short, actionable)
- **CTA id** + client rendering (button/link)
- Optional `details` fields để UI hiển thị (maxBytes, allowedExt…)

FE requirements:
- `ApiError` hiển thị `traceId` (copy button) trong ErrorState/toast.
- Với upload errors: gợi ý rõ (đổi file, giảm dung lượng, thử lại).

---

## 7. Validation-A — Input Validation

### 7.1 Upload endpoints

Áp dụng cho:
- `meeting-service: POST /meetings/upload`
- `processing-service: POST /processing/upload`
- `ai-service: POST /api/upload-audio`

Rules:
- Size limit thống nhất.
- Extension allowlist thống nhất.
- MIME sniff + mismatch handling (best-effort).
- Reject “octet-stream” nếu không sniff được và extension không nằm allowlist.
- Always include `traceId`, `errorCode`, `details`.

### 7.2 Realtime chunk validation

Áp dụng cho:
- WebSocket message `audio.chunk` (processing-service).
- ai-service `/api/v1/stt/stream` file chunk.

Rules:
- max chunk bytes
- seq monotonic
- encoding/container allowlist
- reject invalid payload early với errorCode.

---

## 8. Security-D — Upload Security

MVP deliverables:
- File path safety (đã có một phần) → chuẩn hoá, test.
- Optional scan hook:
  - Env: `UPLOAD_SECURITY_SCAN_ENABLED`
  - Log: `UPLOAD_SECURITY_SCAN_SKIPPED` / `UPLOAD_SECURITY_SCAN_FAILED` / `UPLOAD_SECURITY_SCAN_PASSED`

---

## 9. Upload Validation — Client/Server Sync

- FE dùng cùng allowlist + maxBytes như backend (build-time config hoặc contract endpoint).
- UI hiển thị “Định dạng hỗ trợ” lấy từ config/contract thay vì hardcode.
- FE preflight validate trước khi upload:
  - extension + size
  - show error VN + CTA trước khi gọi API

---

## 10. Observability / Logs

Chuẩn log marker (không log secrets):

- `ERROR_RESPONSE_SENT` (đã có trên Java)
- `UPLOAD_VALIDATION_FAILED` (new)
- `UPLOAD_SECURITY_SCAN_*` (new)
- `REALTIME_VALIDATION_FAILED` (new)

Tất cả log include: `traceId`, `requestId` (nếu có), `userId` (nếu safe), `path`, `errorCode`.

---

## 11. Test Plan (TDD)

### Unit tests (Java)
- GlobalExceptionHandler maps đúng `errorCode` + message + `x-trace-id`.
- Upload controller rejects:
  - empty file
  - too large
  - unsupported extension
  - invalid filename (`..`)
  - mime mismatch (khi sniff implemented)

### Unit tests (Python)
- upload endpoint size + extension enforcement; returns structured error payload with `traceId`.

### FE tests
- preflight validation message VN
- ApiError renders traceId + CTA

---

## 12. Rollout Plan

- Add feature flags default conservative.
- Deploy behind flags, monitor `UPLOAD_VALIDATION_FAILED` rate.

---

## 13. Definition of Done

- [ ] Tất cả lỗi P0 có `errorCode`, VN `message`, `traceId`, CTA mapping.
- [ ] Upload/realtime validation rules thống nhất FE + backend.
- [ ] No regression: upload + realtime + analysis flows pass.
- [ ] Tests cover all P0 branches and run in CI.

