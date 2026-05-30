# Auth Ownership + Raw Transcript Export Audit Results

## Scope

- Branch: `feature/auth-ownership-transcript-export-spec`
- Target phase: `7P — Auth Entry + Ownership Hardening + Raw Transcript Export MVP`
- Status: audit only, no runtime implementation

## Method

- CodeGraph commands used:
  - `codegraph status`
  - `codegraph context "7P Auth Entry Ownership Hardening Raw Transcript Export register login owner scoped meeting transcript report export"`
  - `codegraph query "user-api register login auth token frontend register route auth context"`
  - `codegraph query "meeting-service ownerId userId list detail rename delete ownership check"`
  - `codegraph query "processing-service report export transcript saved analysis owner scoped meetingId raw transcript export txt csv"`
  - `codegraph query "FE-Audiomind auth login register meeting history export raw transcript"`
  - `codegraph affected`
- Targeted reads used:
  - `demoRecordAUDIOMID/user-service/src/main/java/com/example/userservice/controller/UserController.java`
  - `demoRecordAUDIOMID/user-service/src/main/java/com/example/userservice/service/UserService.java`
  - `demoRecordAUDIOMID/user-service/src/main/java/com/example/userservice/config/SecurityConfig.java`
  - `demoRecordAUDIOMID/user-service/src/main/java/com/example/userservice/controller/GlobalExceptionHandler.java`
  - `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java`
  - `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/service/MeetingService.java`
  - `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/entity/Meeting.java`
  - `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/repository/MeetingRepository.java`
  - `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/GlobalExceptionHandler.java`
  - `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/config/SecurityConfig.java`
  - `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/interfaces/http/MeetingV1Controller.java`
  - `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/application/MeetingRecordApplicationService.java`
  - `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java`
  - `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`
  - `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportDocxGenerator.java`
  - `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/SecurityConfig.java`
  - `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/GlobalExceptionHandler.java`
  - `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/http/ProcessingV1Controller.java`
  - `FE-Audiomind/src/app/App.tsx`
  - `FE-Audiomind/src/components/dashboard/LoginModal.tsx`
  - `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`
  - `FE-Audiomind/src/services/auth.ts`
  - `FE-Audiomind/src/services/auth.test.ts`
  - `FE-Audiomind/src/services/api.ts`
  - `packages/api-clients/meeting.ts`
  - `packages/api-clients/processing.ts`
  - `packages/contracts/meeting-api.yaml`
- No runtime changes.

## Auth/register current state

- `POST /api/users/register` already exists and is public in `user-service`.
- `POST /api/users/login` already exists and is public in `user-service`.
- `UserService.register(...)` enforces unique username/email and returns `RegisterResponse`.
- `UserService.login(...)` returns access token and expiry.
- FE currently stores access token and expiry in `localStorage`.
- FE login UX exists in the main app page and in the modal, but register is still a tabbed stub rather than a dedicated route.
- For 7P, the recommended MVP is a dedicated `/register` route with links back to login; the modal register tab can remain as a secondary entry, but not the only user-facing register path.

## Meeting ownership current state

- `Meeting` already stores `ownerUserId` and `deletedAt`.
- `MeetingController` is the active owner-scoped REST surface for list/detail/rename/delete/status update.
- `MeetingService` already provides owner-scoped methods such as `findByIdForOwner`, `findMeetingsForOwner`, `renameMeetingForOwner`, and `softDeleteForOwner`.
- `MeetingRepository` already exposes owner-filtered queries, including deleted-at filters.
- Missing owner access in meeting-service becomes `404` through `NoSuchElementException` handling.
- There is also a legacy `/api/v1/meetings` controller that is not owner-scoped.
- During 7P implementation, that legacy v1 surface should be audited as a BOLA surface; if it remains reachable, it must either apply the same owner checks or be deprecated/blocked if no longer used.

## Processing/report/export current state

- `processing-service` is authenticated by default at the security layer.
- `ProcessingService.assertMeetingAccess(...)` validates ownership by calling meeting-service before transcript/analysis/report reads.
- `getTranscript(...)` reads saved job state first, then falls back to AI service transcript fetch when saved state is missing or empty.
- 7P raw export must not call `getTranscript(...)` directly if that fallback remains enabled.
- A new saved-only transcript read helper is the right boundary for raw export.
- `getAnalysisReadOnly(...)` is owner-gated and can avoid lazy trigger.
- `generateMeetingReportDocx(...)` is owner-gated and builds DOCX from meeting metadata plus transcript/analysis assembly.
- DOCX export exists, but raw transcript `.txt`/`.csv` export does not.
- The current transcript/report path is not suitable as-is for the raw export MVP because transcript reads can still fall back to AI service rather than using saved transcript only.

## Frontend auth/export current state

- FE login uses `FE-Audiomind/src/app/App.tsx` and `FE-Audiomind/src/services/auth.ts`.
- `LoginModal` has login/register tabs, but register is not a real route and still behaves like a demo stub.
- The `/register` route is the recommended MVP entry; the modal register tab should stay secondary only.
- `MeetingHistoryScene` supports list/detail/rename/delete and DOCX export only.
- `FE-Audiomind/src/services/api.ts` has `downloadMeetingReport(..., 'docx')`, `getTranscript`, and `getSavedAnalysis`, but no raw transcript download helper.
- FE contract/client code currently does not define a raw transcript export endpoint.

## Contract/client impact

- If 7P adds `GET /processing/{meetingId}/transcript/export?format=txt` and `GET /processing/{meetingId}/transcript/export?format=csv`, then the processing contract should be updated if this repo tracks it.
- If FE consumes generated clients, the generated processing client should be refreshed as part of implementation.
- FE download helpers should treat raw transcript export as a Blob/file response, not as JSON.
- CSV is required in the MVP alongside TXT; there is no optional or TXT-first fallback for 7P.

## Main gaps

- No dedicated FE register route or real register entry flow.
- No explicit backend plan yet for a dedicated raw transcript export endpoint.
- No TXT/CSV export helper in FE.
- Raw transcript export must be saved-only, owner-scoped, and must not reuse STT/Gemini fallback logic.
- Legacy v1 meeting surface must be treated as a BOLA surface during implementation.
- Cross-owner behavior is currently mostly normalized to `404`; keep that convention unless the team standardizes on `403` consistently.
- Raw transcript CSV is required in the MVP alongside TXT.

## Recommended implementation plan

1. Auth/register FE entry
2. Meeting owner checks
3. Processing/report owner checks
4. Raw transcript TXT/CSV export
5. FE raw transcript export UX
6. Tests
7. Contract/client refresh if the export endpoint is added to the tracked API surface

## Open questions / blockers

- Does the current FE auth flow want a dedicated `/register` route or only a stronger modal flow?
- Should cross-owner requests continue to return `404`, or should the product standardize on `403`?
- Should raw transcript export live in `processing-service` as an extension of the transcript/report surface?
- CSV is required in MVP alongside TXT.
- Do any legacy v1 endpoints remain in active use and require parallel hardening?

## Confirmation

- Spec-only
- No runtime changes
- No commit
