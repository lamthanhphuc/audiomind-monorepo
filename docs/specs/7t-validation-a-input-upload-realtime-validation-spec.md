# 7T-Validation-A - Input / Upload / Realtime Validation Spec

Updated: 2026-06-12

This is a pre-beta spec. It defines validation rules that must run before expensive or state-changing provider calls. The system must reject invalid requests early, return structured errors from `7t-errorux-a-user-facing-error-system-spec.md`, and avoid wasting Deepgram/Gemini cost.

## 1. Goal

- Prevent invalid upload, realtime, re-analyze, search, export, title, auth, admin, and future payment requests.
- Block obvious invalid requests in FE when possible.
- Always revalidate on backend even if FE misses it.
- Never call Deepgram or Gemini for invalid input, empty transcript, invalid audio capture, unauthorized access, stale realtime sessions, or export missing saved analysis.
- Return structured, safe user-facing errors with `errorCode`, `traceId`, and `retryable`.

## 2. Validation Matrix

| Area | Validation | FE responsibility | Backend responsibility | Error code | Provider call allowed? | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| Upload | Non-empty file | Disable submit / show message if file missing or zero bytes. | Reject zero-byte multipart/file path. | `EMPTY_FILE` | No | FE missing file; backend empty file. |
| Upload | Max size from central policy | Show max-size message before upload when `File.size` known. | Enforce central size limit for upload and fallback. | `UPLOAD_TOO_LARGE` | No | Oversized upload/fallback rejected. |
| Upload | Allowed MIME/extensions | Allow only configured audio types; show unsupported format. | Enforce MIME and extension allowlist; never trust client MIME alone. | `UNSUPPORTED_AUDIO_TYPE` | No | Bad MIME/extension rejected. |
| Upload | Duration if available | Warn/block obviously empty or extreme duration when browser metadata available. | Optional duration validation if media probing exists; otherwise rely on size/type. | `VALIDATION_ERROR` | No if invalid | Duration-invalid fixture. |
| Upload | Filename safe | Display sanitized filename; do not use raw path. | Strip path separators/control chars; store safe original name only. | `VALIDATION_ERROR` | No if invalid | Unsafe filename sanitized/rejected. |
| Realtime | Browser MediaRecorder support | Detect `getUserMedia` and `MediaRecorder` support before start. | Not applicable. | `BROWSER_NOT_SUPPORTED` | No | Unsupported browser path. |
| Realtime | Microphone permission | Catch denied permission and show guidance. | Not applicable. | `MIC_PERMISSION_DENIED` | No | Denied mic maps correctly. |
| Realtime | One active recording session | Disable/dedupe start while recording/finalizing. | Reject conflicting active session for same meeting/user. | `VALIDATION_ERROR` | No extra provider call | Double start guarded. |
| Realtime | WebSocket auth/session valid | Send auth init with current token; drop stale queued audio by session token. | Authenticate socket; reject missing/expired token, stale token, mismatched meeting/session. | `UNAUTHORIZED`, `TOKEN_EXPIRED`, `OWNER_FORBIDDEN` | No if invalid | Stale session rejected. |
| Realtime | Stale meeting/session rejected | Increment run/session ids on meeting switch; ignore stale callbacks. | Validate `meetingId`, `recordingSessionId`, `attemptId`, `connectionSeq`. | `VALIDATION_ERROR` | No | Meeting switch during hydration retry. |
| Realtime | Invalid audio capture status | Track speech signal + tiny chunk streak; show guidance. | Persist `FAILED_AUDIO_CAPTURE`; do not call STT/Gemini when invalid capture is terminal. | `INVALID_AUDIO_CAPTURE`, `FAILED_AUDIO_CAPTURE` | No after terminal invalid | Tiny chunks + speech -> no Gemini. |
| Realtime | No valid audio | Show controlled no-transcript or invalid-capture based on signals. | Distinguish true silence from invalid capture. | `NO_TRANSCRIPT` status or `FAILED_AUDIO_CAPTURE` | No Gemini when rows `0` | True no-speech vs invalid audio. |
| Re-analyze | Meeting owner | Disable if not owner when known. | Verify current user owns `meetingId`. | `OWNER_FORBIDDEN` | No | Other user's meeting blocked. |
| Re-analyze | Transcript rows `>0` | Disable or show transcript required when known. | Reject rerun with no saved transcript rows. | `ANALYSIS_REQUIRED` | No | Empty transcript rerun rejected. |
| Re-analyze | Cooldown / double-click spam | Disable button while request in flight. | Use lock/idempotency to return existing run or busy error. | `ANALYSIS_BUSY` | No duplicate call | Double click has one Gemini call. |
| Re-analyze | Preserve v2 | Show backend metadata and do not send v1 by default. | Default/preserve `gemini-business-v2`; block v2 -> v1 downgrade. | `ANALYSIS_VERSION_DOWNGRADE_BLOCKED` | No v1 call | v2 meeting + v1 request blocked. |
| Re-analyze | Idempotency/cache | Include/request stable idempotency where available. | Cache key includes transcript hash + prompt/schema version. | `ANALYSIS_BUSY` or success | Only if cache miss and valid | v1 cache not reused for v2. |
| Search | Trim query | Trim UI input. | Trim and normalize query. | `QUERY_TOO_SHORT` | No search if invalid | Whitespace query rejected. |
| Search | Min length | Block one-character query in FE. | Reject one-character query. | `QUERY_TOO_SHORT` | No | FE no API call for one-char; backend rejects. |
| Search | Limit clamp | Clamp UI controls to safe range. | Clamp `limit` to server max. | `VALIDATION_ERROR` | Search allowed after clamp | Limit abuse test. |
| Search | Context clamp | Clamp context before request. | Clamp context to safe range. | `VALIDATION_ERROR` | Search allowed after clamp | Context abuse test. |
| Search | No raw query logs | Never log raw query. | Log only `queryLength`, token count, result count. | n/a | n/a | Log safety scan. |
| Export | Meeting owner | Hide/disable export if not allowed. | Verify owner. | `OWNER_FORBIDDEN` | No | Forbidden export blocked. |
| Export | Saved analysis required | Show analysis required state. | Return controlled 409 if saved analysis missing. | `EXPORT_ANALYSIS_REQUIRED` | No Gemini | Export before analysis. |
| Export | No lazy Gemini | Never trigger analysis from export UI. | Export/action-plan must only read saved analysis. | `EXPORT_ANALYSIS_REQUIRED` | No | Assert no Gemini during export. |
| Export | Evidence confidence gate | Show unavailable evidence safely. | Verify evidence against persisted transcript rows. | `EXPORT_EVIDENCE_UNAVAILABLE` | No provider call | Weak/wrong evidence rejected. |
| Grouped action plan | Saved analysis required | Show grouped plan only from saved analysis or local fallback. | Require saved analysis for grouped export; never create grouped data through export. | `EXPORT_ANALYSIS_REQUIRED` | No Gemini | Grouped export before analysis rejected. |
| Grouped action plan | Shape and caps | Render only normalized sections/items/subtasks. | Normalize or reject malformed `groupedActionPlan`; cap sections/items/subtasks/notes/keywords/source ids. | `GROUPED_ACTION_PLAN_INVALID` | No | Malformed/oversized grouped payload handled safely. |
| Grouped action plan | Missing grouped field | Show empty/fallback state without crashing. | Allow old saved analysis; build deterministic fallback from flat action items when supported. | `GROUPED_ACTION_PLAN_UNAVAILABLE` | No | Old saved analysis works without provider call. |
| Grouped action plan | Evidence verification | Show verified evidence only when returned by backend. | Verify item/subtask evidence through Search-A over persisted transcript rows. | `EXPORT_EVIDENCE_UNAVAILABLE` | No provider call | Weak/wrong grouped evidence rejected. |
| Grouped action plan | Canonical field name | Read `groupedActionPlan` as canonical. | Public responses emit `groupedActionPlan` only; duplicate snake/camel variants normalized or rejected by policy. | `GROUPED_ACTION_PLAN_INVALID` | No | Duplicate `groupedActionPlan`/`grouped_action_plan` fixture handled. |
| Grouped action plan | Cache feature set | Display grouped output only when backend returns grouped-capable analysis or fallback. | Do not reuse old v2 cache without grouped plan for grouped-capable request. | `ANALYSIS_BUSY` or success | Gemini only on valid cache miss | Old v2 cache without grouped plan not reused. |
| Meeting title | Trim | Trim input. | Trim before save. | `VALIDATION_ERROR` | n/a | Whitespace title. |
| Meeting title | Max length | Enforce UI max length. | Enforce server max length. | `VALIDATION_ERROR` | n/a | Huge title rejected. |
| Meeting title | Fallback safe title | Show safe default. | Generate safe fallback title if empty. | `VALIDATION_ERROR` or fallback | n/a | Empty title fallback. |
| Auth | Token required | Redirect/show login when no token. | Reject missing token. | `UNAUTHORIZED` | No | Missing token. |
| Auth | Expired token | Clear expired local token. | Reject expired token. | `TOKEN_EXPIRED` | No | Expired token flow. |
| Auth | Owner gate | Avoid rendering forbidden actions when known. | Check owner for meeting, processing, realtime, export. | `OWNER_FORBIDDEN` | No | Owner forbidden surfaces. |
| Auth | No user enumeration | Show generic login/register failure. | Do not reveal whether username/email exists in login. | `UNAUTHORIZED` / `VALIDATION_ERROR` | No | Login error generic. |
| Admin/payment future-proof | Role validation | Hide admin actions from non-admin users. | Enforce role gate. | `OWNER_FORBIDDEN` | No | Non-admin blocked. |
| Admin/payment future-proof | Action target validation | Validate target IDs before request. | Validate target exists and belongs to allowed scope. | `VALIDATION_ERROR` | No | Bad target rejected. |
| Admin/payment future-proof | Status transition validation | Disable invalid transitions. | Enforce finite-state transitions. | `VALIDATION_ERROR` | No | Invalid transition rejected. |
| Admin/payment future-proof | Audit log required | n/a | Record safe actor/action/target metadata; no secrets. | n/a | n/a | Audit log metadata test. |

## 3. Central Policies

Upload/fallback policy:

- Single source of truth for max upload/fallback size.
- MVP fallback max: `200MB` unless repo config defines a stricter central value.
- Allowed fallback MIME for realtime final audio: `audio/webm`, `audio/webm; codecs=opus`.
- Upload allowed MIME/extensions must be documented and tested.

Provider-call policy:

- Deepgram may be called only after audio input passes auth, owner, size, MIME, session, and invalid-capture checks.
- Gemini may be called only when transcript rows `>0`, transcript text is non-empty, version guard passes, and cache/idempotency says a new call is needed.
- Export must not call Gemini.
- Grouped action plan preview/export must not call Gemini.
- Grouped action plan preview/export must use saved analysis plus deterministic local fallback only.
- Grouped action plan generation may call Gemini only through the normal analysis or re-analysis path after auth, owner, transcript, version, and cache/feature-set validation pass.
- Search must not call any provider.

## 4. FE Validation Responsibilities

Likely FE files:

- `FE-Audiomind/src/app/App.tsx`
- `FE-Audiomind/src/services/api.ts`
- `FE-Audiomind/src/services/auth.ts`
- `FE-Audiomind/src/hooks/useAudioRecorder.ts`
- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`
- `FE-Audiomind/src/components/realtime/AudioRecorderButton.tsx`
- `FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx`
- `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`

Requirements:

- Block obvious invalid actions before API calls.
- Still display backend validation errors from ErrorUX-A.
- Preserve `traceId`.
- Disable double-click operations while in flight.
- Ignore stale realtime callbacks.
- Avoid raw query/transcript/audio logging.

## 5. Backend Validation Responsibilities

Likely backend files:

- `ProcessingService.java`
- `MeetingWebSocketHandler.java`
- `AIServiceClient.java`
- `JobStateStore.java`
- `TranscriptEvidenceSearchService.java`
- `MeetingActionPlanBuilder.java`
- `MeetingServiceClient.java`
- AI service `app/main.py`, `app/pipeline.py`, `stt_session_actor.py`, `stt_adapter.py`

Requirements:

- Validate every request even when FE already validates it.
- Return ErrorUX-A structured errors.
- Persist terminal statuses for realtime/fallback idempotency.
- Avoid provider calls for invalid/no-transcript cases.
- Normalize or reject malformed grouped action plan payloads before FE/DOCX rendering.
- Enforce grouped action plan caps before rendering: max 8 sections, 8 items per section, 8 subtasks per item, 8 notes, 8 evidence keywords, and 8 source action ids.
- Allow missing `groupedActionPlan` for old saved analysis.
- If malformed grouped data can fallback to flat `action_items`, use fallback instead of user-visible failure.
- If malformed grouped data cannot fallback, return `GROUPED_ACTION_PLAN_INVALID` with structured safe error response.
- Require owner plus saved analysis before grouped action-plan preview/export.
- Verify grouped item/subtask evidence only through Search-A persisted transcript matches.
- Never trust model-provided `evidenceQuote`, grouped item text, description, or note text as verified evidence.
- Keep public grouped field naming stable as `groupedActionPlan`; do not emit both snake_case and camelCase variants in API responses.
- Keep validation logs safe and metadata-only.

## 6. Acceptance

- Invalid input returns structured error from ErrorUX-A.
- Invalid requests do not call Deepgram/Gemini.
- FE blocks obvious invalid requests before API when possible.
- Backend still validates everything even if FE misses it.
- Grouped action plan malformed/missing cases are safe, bounded, and provider-free.
- Tests cover FE and backend validation.
- Log-safety scan passes for validation failures.

## 7. Grouped Action Plan Validation Details

Missing grouped plan:

- Old saved analysis without `groupedActionPlan` is allowed.
- If flat `action_items` exists, return 200 and render deterministic `Công việc chung` fallback.
- If no flat action items exist, return 200 with empty-state text `Chưa có công việc đủ rõ để phân nhóm.`
- Do not call Gemini from preview/export to create missing grouped data.

Malformed grouped plan:

- Normalize/cap before FE or DOCX rendering.
- If normalized output is safe, render it.
- If normalization fails but flat `action_items` fallback exists, render fallback.
- If normalization fails and no fallback exists, return `GROUPED_ACTION_PLAN_INVALID`.
- Never include raw grouped payload, raw transcript, raw prompt, raw Gemini response, evidence keywords, owner/deadline values, tokens, Authorization values, device ids, or env secret values in validation responses/logs.

Field naming:

- Public API responses must emit `groupedActionPlan`.
- Public API responses must not emit both `groupedActionPlan` and `grouped_action_plan`.
- If a compatibility reader accepts `grouped_action_plan`, it must normalize to `groupedActionPlan`.

Export validation:

- Grouped preview/export requires owner access and saved analysis.
- Grouped preview/export must not call Gemini, lazy analysis, STT, Whisper, Ollama, or process/start.
- Existing general report export remains unchanged unless explicitly implemented and tested.

Evidence validation:

- Verified grouped evidence requires Search-A match against persisted transcript rows.
- Weak evidence remains unverified.
- Model `evidenceQuote` is never trusted by itself.

Required tests:

- Old saved analysis without grouped plan renders safely.
- Malformed grouped plan falls back or returns `GROUPED_ACTION_PLAN_INVALID`.
- Over-limit sections/items/subtasks/notes/keywords/source ids are capped.
- No export-time Gemini for grouped preview/DOCX.
- Owner-forbidden grouped preview/export is blocked.
- Weak grouped evidence is not verified.
