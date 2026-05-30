# 7P — Auth Entry + Ownership Hardening + Raw Transcript Export MVP

## 1. Status

- SPEC-ONLY
- Branch: `feature/auth-ownership-transcript-export-spec`
- Date: 2026-05-30
- No runtime changes in this branch

## 2. Background

- Sau 7N, app đã có meeting management và duplicate upload guard.
- Sau 7O, app đã có DOCX meeting report export.
- Trước khi mở full raw transcript export, cần đảm bảo object-level authorization.
- User phải chỉ xem/sửa/xóa/export dữ liệu meeting của chính mình.
- FE cũng cần có entry rõ ràng để user đăng ký/login.

## 3. Goals

- Add FE `/register` route as the recommended MVP entry.
- Keep login/register navigation clear.
- Audit and harden owner-scoped meeting access.
- User can only list/detail/rename/delete/export own meetings.
- Add raw transcript export TXT.
- Add raw transcript export CSV.
- Ensure export uses saved transcript only.
- Ensure export does not call STT/Gemini/processing start.

## 4. Non-goals

- No OAuth/social login.
- No forgot password/email verification.
- No admin/role permission system.
- No transcript cleanup/readable transcript generation.
- No vi+en/multi STT optimization.
- No PDF export.
- No rerun STT/Gemini.
- No broad auth rewrite unless current implementation requires it.

## 5. Current system audit

### User/Auth inventory

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Register API | `demoRecordAUDIOMID/user-service/src/main/java/com/example/userservice/controller/UserController.java` | `POST /api/users/register` exists and calls `UserService.register(...)`. | FE has no dedicated register route/page; register is only a tab inside the modal. |
| Login API | `demoRecordAUDIOMID/user-service/src/main/java/com/example/userservice/controller/UserController.java` | `POST /api/users/login` exists and returns JWT access token. | FE login screen exists, but register navigation is not route-based. |
| Auth storage | `FE-Audiomind/src/services/auth.ts` | Access token and expiry are stored in `localStorage`. | No refresh-token flow or register-specific auth flow yet. |
| Auth entry UI | `FE-Audiomind/src/app/App.tsx`, `FE-Audiomind/src/components/dashboard/LoginModal.tsx` | App shows a login page/modal; `LoginModal` contains a register tab, but not a route. | Add clear login/register navigation and a real register entry point. |

### Meeting ownership inventory

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Meeting entity | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/entity/Meeting.java` | Owns `ownerUserId`, `deletedAt`, `status`, `language`, `audioHash`. | Ownership field exists and can support object-level authorization. |
| Owner-scoped list/detail/update | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java` | `GET /meetings`, `GET /meetings/{id}`, `PATCH /meetings/{id}`, `DELETE /meetings/{id}`, `PATCH /meetings/{id}/status` all call owner-scoped service methods using authenticated principal. | Existing active surface is already owner-scoped; keep it consistent. |
| Owner-scoped repository helpers | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/repository/MeetingRepository.java` | Repository exposes owner-filtered lookups and deleted-at filters. | No new model field is needed for 7P. |
| Owner error behavior | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/GlobalExceptionHandler.java` | Missing owner match is handled as `404 Resource not found`. | Keep response code semantics stable unless a different convention is chosen deliberately. |
| Legacy v1 surface | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/interfaces/http/MeetingV1Controller.java` | Legacy `/api/v1/meetings` controller exists and is not owner-scoped. | During 7P implementation, audit it as a BOLA surface; if it remains reachable, apply the same owner checks or deprecate/block it if no longer used. |

### Processing/report/transcript inventory

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Processing security | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/SecurityConfig.java` | All routes are authenticated except `/health`, `/ready`, actuator, and websocket GETs. | Ownership still needs to be enforced at service boundary via meeting lookup. |
| Access gate | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java` | `assertMeetingAccess(...)` calls meeting-service and maps `403` / `404` to matching responses. | Raw export must reuse a similar owner gate, not a bypass. |
| Transcript read path | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java` | `getTranscript(...)` first reads saved job state, then falls back to AI service transcript fetch when saved state is missing or empty. | Raw export MVP must not reuse AI fallback. |
| Saved-only transcript helper | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java` | No dedicated saved-only transcript helper exists yet. | Raw export should use a new helper that reads saved transcript only and does not call `getTranscript(...)`. |
| Saved analysis path | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java` | `getAnalysisReadOnly(...)` is owner-gated and can return saved analysis without lazy trigger. | Good source for 7P report/export scoping, but raw export should stay transcript-only. |
| DOCX export | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`, `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportDocxGenerator.java` | DOCX export is owner-gated and builds report data from meeting metadata plus saved transcript/analysis. | Raw transcript export API does not exist yet. |

### Frontend inventory

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Login screen | `FE-Audiomind/src/app/App.tsx` | FE has a login page flow that calls `/api/users/login` and stores token. | No dedicated `/register` route exists. |
| Modal auth UI | `FE-Audiomind/src/components/dashboard/LoginModal.tsx` | Modal contains login/register tabs and fields, but submit still behaves like a demo stub. | Keep it as a secondary entry, but not the only user-facing register entry. |
| Meeting history/detail | `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx` | FE lists meetings, loads detail, renames, deletes, and exports DOCX report. | No raw transcript export button or helper. |
| FE API layer | `FE-Audiomind/src/services/api.ts` | Supports `downloadMeetingReport(..., 'docx')`, `getTranscript`, `getAnalysis`, `getSavedAnalysis`. | No TXT/CSV export helper exists. |

### API inventory

| Endpoint | Current behavior | Ownership status | Needed change |
| -------- | ---------------- | ---------------- | ------------- |
| `POST /api/users/register` | Register user and issue user id response. | Public, intended. | FE route/navigation must expose it clearly. |
| `POST /api/users/login` | Login and return access token. | Public, intended. | FE login/register flow should be cleanly linked. |
| `GET /meetings` | Returns authenticated user’s meetings through owner-scoped service. | Owner-scoped. | Preserve and validate no cross-user leakage. |
| `GET /meetings/{id}` | Returns one meeting only if owner matches. | Owner-scoped. | Preserve 404/forbidden semantics. |
| `PATCH /meetings/{id}` | Renames only if owner matches. | Owner-scoped. | Preserve. |
| `DELETE /meetings/{id}` | Soft-deletes only if owner matches. | Owner-scoped. | Preserve. |
| `PATCH /meetings/{id}/status` | Updates status only if owner matches. | Owner-scoped. | Preserve. |
| `GET /processing/{meetingId}/transcript` | Returns saved transcript with AI fallback if saved state is missing/empty. | Owner-gated, but not saved-only. | Add raw transcript export endpoint that is saved-only. |
| `GET /processing/{meetingId}/report` | DOCX report export with owner gate and transcript/analysis assembly. | Owner-gated. | Keep for 7O; raw export must be separate. |

## 6. Contract/client impact

If implementation adds:
- `GET /processing/{meetingId}/transcript/export?format=txt`
- `GET /processing/{meetingId}/transcript/export?format=csv`

then update:
- processing OpenAPI/contract if this repo tracks it
- generated API client if used by FE
- FE download helper should handle Blob/file response, not JSON parser

## 7. Ownership model decision

Recommended:
- Backend must be source of truth.
- FE filtering is not security.
- Every endpoint accepting `meetingId` must verify ownership.
- Use current authenticated user id from token/security context.
- Do not trust userId passed from FE body/query if avoidable.

Owner-scoped resources:
- meeting list
- meeting detail
- rename meeting
- soft delete meeting
- DOCX report export
- raw transcript TXT/CSV export
- saved transcript read
- saved analysis read if exposed through meeting detail

Cross-owner response:
- Prefer `404` to avoid leaking whether a meeting exists.
- Use `403` only if current convention already uses it consistently.
- Missing/invalid auth should return `401`.

## 8. Auth Entry FE plan

MVP:
- Add `/register` route as the recommended MVP.
- Register form fields:
  - display name or name if backend supports it
  - email
  - password
  - confirm password
- FE validates:
  - email required
  - password required
  - confirm password matches
- On success:
  - redirect to login unless backend safely returns a login token
  - auto-login only if backend already returns token safely
- Login screen should link to Register.
- Register screen should link back to Login.

Do not add forgot password/social login in MVP.

## 9. Raw Transcript Export API plan

Recommended endpoint:

```txt
GET /processing/{meetingId}/transcript/export?format=txt
GET /processing/{meetingId}/transcript/export?format=csv
```

Rules:
- Owner-scoped.
- Uses saved transcript only.
- Must use a new saved-only transcript read helper.
- Do not reuse `getTranscript(...)` if that method can fallback to AI service.
- Does not call STT.
- Does not call Gemini.
- Does not call processing start.
- Does not perform transcript cleanup.
- Deleted meeting should not export through normal path.
- Missing saved transcript should return a clear `404`, `409`, or `422` based on the existing error convention for this service.

TXT format:

```txt
Meeting:
Recognition Mode:
Detected Transcript Language:
Generated At:

[00:25–00:28] SPEAKER_1: The problem is that when you speak English.
```

CSV columns:

```txt
index,startTime,endTime,speaker,text
```

Response headers:

- TXT: `Content-Type: text/plain; charset=utf-8`
- CSV: `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="meeting-9-transcript.txt"` / `meeting-9-transcript.csv` as an example

## 10. FE Raw Transcript Export plan

Add in meeting detail:
- Button/dropdown: `Export transcript`
- Options: `Download TXT`, `Download CSV`
- Loading state.
- Error state.
- Use file download helper, not JSON parser.
- Do not trigger processing/start.
- Do not trigger analysis.

## 11. Security risk matrix

| Risk | Impact | Likelihood | Mitigation |
| ---- | ---- | ---- | ---- |
| User changes meetingId to access another user data | High | High | Owner check in service/repository. |
| FE hides data but backend still leaks | High | Medium | Backend source-of-truth authorization. |
| Report export bypasses ownership | High | Medium | Apply owner check to DOCX export. |
| Transcript export leaks sensitive raw data | High | High | Owner-scoped export + tests. |
| Internal service loses user context | Medium | Medium | Explicit authenticated user propagation/verification. |
| Deleted meeting still exportable | Medium | Medium | Exclude deleted meetings. |
| Export accidentally triggers STT/Gemini | High | Medium | Saved transcript only + tests/log smoke. |

## 12. Implementation order

1. Audit auth/register/login current state.
2. Audit owner field and all meetingId endpoints.
3. Define shared owner-check helper or repository method.
4. Harden meeting-service list/detail/rename/delete.
5. Harden processing-service report export.
6. Add raw transcript export TXT.
7. Add raw transcript export CSV.
8. Add FE register route/form.
9. Add FE raw transcript export button/helper.
10. Add backend and FE tests.
11. User runs Docker/browser smoke manually.

## 13. Acceptance criteria

- FE has clear register entry.
- User can register if backend supports it.
- Login/register navigation works.
- User A list only returns User A meetings.
- User A cannot detail User B meeting.
- User A cannot rename/delete User B meeting.
- User A cannot export DOCX report for User B meeting.
- User A cannot export raw transcript for User B meeting.
- Owner can export raw transcript TXT.
- Owner can export raw transcript CSV.
- Legacy `/api/v1/meetings` must not expose cross-user meeting data if still reachable.
- Raw export uses saved transcript only.
- Raw export does not call STT.
- Raw export does not call Gemini.
- No STT routing/default/multi changes.
- No Gemini schema changes.
- No transcript cleanup/readable transcript changes.

## 14. Validation plan

Implementation phase should run:
- backend auth/ownership tests
- backend raw transcript export tests
- legacy `/api/v1/meetings` owner/BOLA tests if the surface remains enabled
- FE register route render and confirm-password validation tests
- FE register success redirect-to-login tests
- FE register route/form tests
- FE export transcript tests
- FE build
- contract/client validation if API contract changes

User manual browser smoke:

1. Register user A.
2. Login user A.
3. Upload/open meeting A.
4. Export DOCX report.
5. Export raw transcript TXT/CSV.
6. Register/login user B.
7. Confirm user B cannot access/export meeting A.
8. Check logs: no STT/Gemini during exports.

## 15. Open questions

- Does backend already support register?
- Should register auto-login or redirect to login?
- Should cross-owner continue to return 404 or standardize on 403?
- Where should raw transcript export live if gateway/contract conventions differ?
- CSV is required in MVP alongside TXT.
- Do internal processing-service calls have reliable user context?
