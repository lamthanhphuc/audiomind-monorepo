# Meeting Management + Duplicate Upload Audit Results

## Scope

- Branch: `feature/meeting-management-duplicate-guard-spec`
- Target phase: `7N — Meeting Management UX + Duplicate Upload Guard`
- Status: audit only, no runtime implementation

### MVP scope confirmed

- Duplicate upload guard for same user + same audioHash
- Search/filter/sort meeting list
- Rename meeting
- Soft delete meeting
- Duplicate banner/redirect UX
- Empty/loading/error polish

### Later scope (out of MVP)

- Hard delete
- Restore deleted meeting
- Retry failed duplicate
- Realtime recording duplicate detection
- Cross-user dedup
- Advanced race-condition handling if DB unique index is too risky

## Method

- CodeGraph commands used: `codegraph status`, `codegraph context`, `codegraph query`, `codegraph affected`
- Targeted reads used: meeting-service controller/entity/service/repository, meeting DB migrations, processing-service controller/service/job store/client, ai-service models/main/pipeline/tasks/job status, FE app/history/upload/service/types/state components
- No runtime changes

## Current upload flow summary

- FE upload flow in `FE-Audiomind/src/app/App.tsx` calls `uploadToMeetingApi(...)`, then `startProcessingByPath(...)`, then polls transcript and analysis.
- Meeting-service upload endpoint persists the meeting row and uploaded file, then returns the created meeting.
- Processing-service has its own job-state idempotency based on `fileId`, but the meeting upload path does not create or pass an audio hash.
- AI-service persists transcript fragments and analysis and tracks analysis job state/cooldown in Redis.

## Current meeting management summary

- Meeting-service can create meeting records and fetch owner-scoped meeting detail and recent meetings.
- The current FE history screen is read-only: it lists recent meetings, lets the user select one, and shows transcript/analysis detail.
- The search field in history/upload/realtime scenes is visual only; there is no functional search/filter/sort.
- There is no rename endpoint, no delete or soft-delete flow, and no management actions in the current UI.

## Duplicate guard gaps

- No owner-scoped audio hash exists on meeting records.
- Duplicate identity is not based on file bytes, so filename reuse would be unsafe.
- Processing idempotency exists for batch job state, but it is keyed by file id, not by duplicate audio uploads in meeting flow.
- No upload response currently returns `duplicate`, `reused`, or an existing meeting reference.
- No policy exists yet for failed or processing duplicates in the meeting upload path.

### Status source clarification

- `processing`: can be derived from active Redis/job state when available.
- `completed`: should require transcript + analysis completed.
- `failed`: must not be reused as completed.
- If status is uncertain, FE should show a clear fallback state/message.

### Old records clarification

- Old meetings without audioHash cannot be deduped safely.
- MVP should dedupe only new uploads after audioHash is available.
- No mandatory backfill of audioHash for legacy records in MVP.

## Data model gaps

- `Meeting` has `id`, `title`, `audioPath`, `originalFileName`, `ownerUserId`, `createdAt`, and `language` only.
- Missing fields for this phase: `audioHash`, `fileSize`, `duration`, `deletedAt`, and a clear lifecycle `status`.
- Existing migrations add `owner_user_id`, `original_file_name`, and `language`, but not upload identity or soft-delete columns.
- Meeting repository supports only recent list and owner-scoped fetch by id.

## API gaps

- No `GET /meetings?query=&status=&language=&sort=` capability.
- No `PATCH /meetings/{id}` rename capability.
- No `DELETE /meetings/{id}` soft-delete capability.
- No meeting upload response contract for duplicate reuse metadata.
- No explicit API contract for reusing completed transcript/analysis from a prior meeting record.

## FE gaps

- History screen is read-only and cannot rename, delete, or filter meetings.
- Search input placeholders exist, but the input is not wired to any list logic.
- Empty/loading/error states exist as generic components, but they are not yet part of a full management workflow.
- Upload screen has no duplicate guard banner or redirect/reuse messaging.

## Recommended implementation plan

1. Backend duplicate guard / audio hash
2. Meeting management read/write APIs
3. FE history management UX
4. Duplicate upload UX
5. Tests + browser smoke

Validation emphasis for implementation phase:

- Prove duplicate completed upload does not call STT.
- Prove duplicate completed upload does not call Gemini.
- Browser smoke should include log verification that second upload does not trigger STT/Gemini.
- Deleted meeting must be excluded from normal list.

## Open questions / blockers

- Delete policy is not defined yet: soft delete vs hard delete.
- Re-upload behavior for a deleted meeting is not defined yet.
- Realtime recordings are out of scope unless explicitly added later.
- Cross-user deduplication is not appropriate for MVP without a privacy decision.
- `codegraph affected` returned a no-arguments warning, so impacted areas were gathered through targeted reads instead.

## Confirmation

- Spec-only
- No runtime changes
- No commit before validation
