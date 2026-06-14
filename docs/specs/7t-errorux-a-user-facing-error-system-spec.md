# 7T-ErrorUX-A - User-Facing Error System Spec

Updated: 2026-06-12

This is a pre-beta spec. It defines the user-facing error contract across FE, processing service, meeting/user services, and AI service. The goal is to prevent raw provider/internal failures from leaking to users while still giving support enough safe metadata to debug issues.

## 1. Goal

Users must understand:

- what went wrong;
- whether they can retry;
- what action to take;
- which `traceId` to share with support if needed.

No user should see raw provider errors, stack traces, raw audio, raw transcript, raw prompt, raw Gemini response, API key, JWT, token, Authorization header, device id, or env secret.

## 2. Standard Backend Error Response Shape

All services should converge on this JSON shape for API errors:

```json
{
  "errorCode": "STRING_ENUM",
  "message": "Safe user-facing or generic message",
  "traceId": "request-trace-id",
  "timestamp": "ISO-8601",
  "path": "/api/path",
  "retryable": true,
  "action": "RETRY | CHECK_MIC | UPGRADE | LOGIN | CONTACT_SUPPORT | NONE"
}
```

Rules:

- `errorCode` must be one of the catalog values in this spec.
- `message` must be safe Vietnamese user-facing text or a generic safe fallback.
- `traceId` comes from `x-trace-id` / `x-request-id` or a server-generated request trace.
- `timestamp` is server time in ISO-8601.
- `path` is the request path, without query values that may include user content.
- `retryable=true` means retrying the same operation may succeed without changing input.
- `action` defines the primary FE CTA.
- Server logs may include technical class/error codes, but no secrets or raw user content.
- Unexpected exceptions must map to `INTERNAL_ERROR` with HTTP 500 and a traceId.

HTTP status guidance:

| Class | HTTP status | Meaning |
| --- | --- | --- |
| Auth missing/expired | 401 | User needs login or token refresh. |
| Owner/permission failure | 403 | Authenticated user cannot access this resource. |
| Validation/input failure | 400 or 413/415 | Request must be fixed before retry. |
| Conflict/current state | 409 | Operation is not valid for current meeting/job state. |
| Busy/rate/timeout | 408/409/429/503/504 | Retry may be valid after delay. |
| Unexpected internal failure | 500 | Contact support with traceId. |

## 3. Error Code Catalog

| Error code | HTTP | Vietnamese message | Retryable | FE action/CTA | Raised by | Tests required |
| --- | --- | --- | --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | Vui lòng đăng nhập để tiếp tục. | false | `LOGIN` | all services/auth filters | Missing token returns structured error; FE shows login CTA. |
| `TOKEN_EXPIRED` | 401 | Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại. | false | `LOGIN` | auth/session validation | Expired token clears session and shows login CTA. |
| `OWNER_FORBIDDEN` | 403 | Bạn không có quyền truy cập nội dung này. | false | `CONTACT_SUPPORT` | meeting/processing/export/realtime owner checks | Other user's meeting returns 403, not 500. |
| `ACCOUNT_LOCKED` | 403 | Tài khoản đang bị khóa. Vui lòng liên hệ hỗ trợ. | false | `CONTACT_SUPPORT` | user service | Locked account cannot login and does not leak details. |
| `EMPTY_FILE` | 400 | File tải lên đang trống. Vui lòng chọn file âm thanh hợp lệ. | false | `NONE` | upload validation | Empty upload returns no provider call. |
| `UPLOAD_TOO_LARGE` | 413 | File quá lớn. Vui lòng chọn file nhỏ hơn giới hạn cho phép. | false | `NONE` | upload/fallback validation | Oversized upload/fallback returns 413. |
| `UNSUPPORTED_AUDIO_TYPE` | 415 | Định dạng âm thanh chưa được hỗ trợ. Vui lòng dùng WebM/Opus hoặc định dạng được cho phép. | false | `NONE` | upload/fallback validation | Bad MIME returns 415 and no provider call. |
| `UPLOAD_PROCESSING_FAILED` | 500 | Không thể xử lý file âm thanh. Vui lòng thử lại sau. | true | `RETRY` | processing upload path | Upload processing failure has traceId. |
| `MIC_PERMISSION_DENIED` | 400 | Trình duyệt chưa được cấp quyền microphone. Hãy cho phép microphone rồi thử lại. | false | `CHECK_MIC` | FE recorder | Denied mic maps to guidance. |
| `BROWSER_NOT_SUPPORTED` | 400 | Trình duyệt không hỗ trợ ghi âm realtime. Vui lòng dùng trình duyệt khác. | false | `NONE` | FE recorder | Missing MediaRecorder/getUserMedia maps safely. |
| `WEBSOCKET_CONNECT_FAILED` | 503 | Không thể kết nối realtime. Vui lòng thử lại. | true | `RETRY` | FE/processing websocket | WebSocket failure is retryable and traceable. |
| `INVALID_AUDIO_CAPTURE` | 400 | Không nhận được âm thanh hợp lệ. Hãy kiểm tra microphone và thử lại. | false | `CHECK_MIC` | FE/processing audio guard | Speech + tiny chunks shows mic guidance. |
| `FAILED_AUDIO_CAPTURE` | 400 | Ghi âm không hợp lệ. Hãy kiểm tra microphone, quyền trình duyệt và thử lại. | false | `CHECK_MIC` | processing status sync | Invalid capture is not no-speech. |
| `REALTIME_FINALIZATION_FAILED` | 500 | Không thể hoàn tất phiên realtime. Vui lòng thử lại. | true | `RETRY` | processing/AI finalization | Stop/finalize failure returns structured error. |
| `STT_UNAVAILABLE` | 503 | Dịch vụ nhận dạng giọng nói đang không khả dụng. Vui lòng thử lại sau. | true | `RETRY` | AI service/STT adapter | Provider unavailable is not raw provider text. |
| `FAILED_STT` | 500 | Không thể tạo transcript từ âm thanh. Vui lòng thử lại hoặc ghi âm lại. | true | `RETRY` | AI service final/live STT | Deepgram failure maps to controlled error. |
| `STT_TIMEOUT` | 504 | Nhận dạng giọng nói quá thời gian chờ. Vui lòng thử lại. | true | `RETRY` | AI service STT deadlines | Timeout has traceId and no hanging job. |
| `STT_FALLBACK_FAILED` | 500 | Không thể khôi phục transcript từ file ghi âm cuối. | true | `RETRY` | final-audio fallback | Fallback failure returns terminal status. |
| `ANALYSIS_BUSY` | 409 | AI đang bận, vui lòng thử lại sau. | true | `RETRY` | analysis idempotency/lock | Busy response disables spam click. |
| `ANALYSIS_REQUIRED` | 409 | Cần có phân tích trước khi thực hiện thao tác này. | false | `NONE` | export/action plan | Export missing analysis shows required message. |
| `ANALYSIS_FAILED` | 500 | Không thể tạo phân tích. Vui lòng thử lại. | true | `RETRY` | AI/Gemini analysis | Gemini failure is safe and traceable. |
| `ANALYSIS_PENDING` | 409 | Phân tích đang được tạo. Vui lòng đợi trong giây lát. | true | `RETRY` | processing analysis status | Pending state is not generic failure. |
| `ANALYSIS_VERSION_DOWNGRADE_BLOCKED` | 409 | Không thể chạy lại phân tích bằng phiên bản cũ hơn. | false | `NONE` | processing/AI rerun guard | v2 -> v1 downgrade blocked. |
| `QUERY_TOO_SHORT` | 400 | Từ khóa tìm kiếm quá ngắn. Vui lòng nhập thêm ký tự. | false | `NONE` | FE/backend search validation | One-character query blocked. |
| `SEARCH_FAILED` | 500 | Không thể tìm kiếm transcript. Vui lòng thử lại. | true | `RETRY` | processing search | Search failure has traceId. |
| `EXPORT_ANALYSIS_REQUIRED` | 409 | Cần có phân tích đã lưu trước khi xuất action plan. | false | `NONE` | export/action plan | No export-time Gemini. |
| `EXPORT_EVIDENCE_UNAVAILABLE` | 200 | Chưa có evidence transcript đáng tin cậy cho mục này. | false | `NONE` | action-plan evidence | Weak/missing evidence is shown as unavailable/unverified; export still succeeds and must not call Gemini. |
| `GROUPED_ACTION_PLAN_UNAVAILABLE` | 200 by default; 409 only for a future strict grouped-only endpoint | Chưa có đủ công việc rõ ràng để phân nhóm. | false | `NONE` | grouped action plan display/export | Display-state only for normal FE/export; old or low-signal analysis shows safe empty/fallback state without Gemini. |
| `GROUPED_ACTION_PLAN_INVALID` | 409/500 | Kế hoạch công việc theo nhóm chưa hợp lệ. Vui lòng chạy lại phân tích hoặc liên hệ hỗ trợ. | false | `CONTACT_SUPPORT` | grouped action plan normalization | Use only when malformed grouped payload cannot safely fallback; no raw payload leak. |
| `GROUPED_ACTION_PLAN_EXPORT_FAILED` | 500 | Không thể xuất kế hoạch công việc theo nhóm. Vui lòng thử lại. | true | `RETRY` | grouped action plan export | Actual DOCX/export generation failure; must include traceId and no raw payload. |
| `EXPORT_FAILED` | 500 | Không thể xuất tài liệu. Vui lòng thử lại. | true | `RETRY` | report/export | Export failure has traceId. |
| `QUOTA_EXCEEDED` | 429 | Bạn đã vượt quá giới hạn sử dụng. Vui lòng nâng cấp hoặc thử lại sau. | false | `UPGRADE` | future quota gate | FE shows upgrade CTA. |
| `PAYMENT_PENDING` | 402 | Thanh toán đang chờ xử lý. Vui lòng kiểm tra lại sau. | true | `RETRY` | future billing | Retryable billing state. |
| `PAYMENT_FAILED` | 402 | Thanh toán thất bại. Vui lòng cập nhật phương thức thanh toán. | false | `UPGRADE` | future billing | Billing CTA. |
| `VALIDATION_ERROR` | 400 | Dữ liệu không hợp lệ. Vui lòng kiểm tra lại. | false | `NONE` | all validation | Field errors map safely. |
| `NETWORK_ERROR` | 0/503 | Mất kết nối mạng. Vui lòng kiểm tra kết nối và thử lại. | true | `RETRY` | FE fetch layer | FE maps network failure centrally. |
| `SERVICE_UNAVAILABLE` | 503 | Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau. | true | `RETRY` | all downstream clients | 503 response is safe. |
| `TIMEOUT` | 504 | Yêu cầu quá thời gian chờ. Vui lòng thử lại. | true | `RETRY` | all long operations | Timeout has traceId. |
| `INTERNAL_ERROR` | 500 | Đã xảy ra lỗi hệ thống. Vui lòng liên hệ hỗ trợ kèm mã traceId. | false | `CONTACT_SUPPORT` | global exception handler | Unexpected error includes traceId. |

## 4. FE Error Mapping Contract

FE must implement a central error mapper used by upload, realtime, re-analyze, search, export, auth, and meeting history surfaces.

Requirements:

- Map backend `errorCode` to Vietnamese UI copy.
- Use a safe fallback for unknown error codes.
- Preserve and display/copy `traceId` when present.
- Show a retry button only when `retryable=true`.
- Show microphone guidance for `MIC_PERMISSION_DENIED`, `INVALID_AUDIO_CAPTURE`, and `FAILED_AUDIO_CAPTURE`.
- Show login CTA for `UNAUTHORIZED` and `TOKEN_EXPIRED`.
- Show upgrade CTA for `QUOTA_EXCEEDED`, `PAYMENT_PENDING`, and `PAYMENT_FAILED`.
- Show contact-support CTA for non-retryable internal/permission errors.
- Show a light empty/fallback state for `GROUPED_ACTION_PLAN_UNAVAILABLE`.
- Show safe retry/support guidance for grouped-plan export failures without rendering raw grouped payloads.
- Do not render raw backend stack traces, raw provider messages, raw transcript, prompt text, or secrets.

Likely FE surfaces:

- `FE-Audiomind/src/services/api.ts` (`ApiError`, fetch parsing).
- `FE-Audiomind/src/services/auth.ts` (login/register/logout error parsing).
- `FE-Audiomind/src/app/App.tsx` (global auth/upload/realtime errors).
- `FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx`.
- `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`.

## 5. Acceptance

- Upload wrong type shows Vietnamese unsupported format message.
- Mic denied shows microphone permission guidance.
- Invalid audio capture shows mic/audio capture guidance.
- Gemini busy shows `AI đang bận, vui lòng thử lại sau.`
- Owner forbidden shows permission error, not 500.
- Export missing analysis shows analysis required, not generic failure.
- Missing grouped action plan shows empty/fallback state and does not call Gemini.
- Invalid grouped action plan shape does not leak raw saved analysis content.
- Grouped action plan export failure maps to a structured retryable error.
- Every backend unexpected error has traceId.
- FE tests cover the central mapper and main surfaces.
- Backend tests cover structured error response shape for validation, auth, realtime, STT, analysis, search, and export.

## 6. Grouped Action Plan Semantics

`GROUPED_ACTION_PLAN_UNAVAILABLE`:

- Usually a display state with HTTP 200, not a blocking error.
- Use message `Chưa có đủ công việc rõ ràng để phân nhóm.`
- `retryable=false`, `action=NONE`.
- Must not trigger Gemini, lazy analysis, STT, Whisper, Ollama, or process/start paths.
- Use 409 only for a future strict grouped-plan endpoint that explicitly cannot return fallback/empty state.

`GROUPED_ACTION_PLAN_INVALID`:

- Use only when saved `groupedActionPlan` is malformed after normalization and cannot safely render.
- If flat `action_items` fallback exists, prefer fallback over a user-visible failure.
- Response and logs must not include the raw grouped payload, section titles, task descriptions, subtasks, notes, evidence keywords, owner/deadline values, raw transcript, raw prompt, or raw Gemini response.
- Include `traceId` for support when the response is an error.

`GROUPED_ACTION_PLAN_EXPORT_FAILED`:

- Use only for actual DOCX/action-plan export generation failure.
- Must include `traceId`.
- Must not include raw grouped payload, raw transcript, prompt text, provider responses, secrets, tokens, Authorization values, device ids, or env secret values in response or logs.
- Must not be used for missing grouped data when fallback/empty state can be rendered.

FE mapping tests:

- Unavailable grouped plan shows an empty/fallback state.
- Invalid grouped payload uses flat action item fallback when available.
- Grouped export failure shows a safe retryable error with traceId.
