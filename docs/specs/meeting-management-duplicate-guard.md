# 7N — Meeting Management UX + Duplicate Upload Guard

## 1. Status

- SPEC-ONLY
- Branch: `feature/meeting-management-duplicate-guard-spec`
- Date: 2026-05-29
- No runtime changes in this branch

## 2. Background

- Sau 7K-pre Meeting History & Detail
- Sau 7M Gemini Business Analysis Optimization
- Cần quản lý meeting tốt hơn
- Cần tránh upload cùng audio nhiều lần làm tốn STT/Gemini
- Duplicate guard phải backend-first, FE chỉ hiển thị trạng thái

## 3. Goals

- Search/filter/sort meetings
- Rename meeting
- Delete or soft delete meeting
- Improve empty/loading/error states
- Detect duplicate audio upload by same user
- Reuse completed transcript/analysis
- Do not rerun STT/Gemini for duplicate completed audio
- Preserve owner/user isolation

## 4. Non-goals

- No STT optimization
- No Gemini schema rewrite
- No realtime pause/resume change
- No hard delete unless explicitly required
- No cross-user duplicate sharing unless privacy is solved
- No full upload pipeline rewrite

## 4.1 MVP scope

- Duplicate upload guard for same user + same audioHash.
- Search/filter/sort meeting list.
- Rename meeting.
- Soft delete meeting.
- Duplicate banner/redirect UX.
- Empty/loading/error polish.

## 4.2 Later scope

- Hard delete.
- Restore deleted meeting.
- Retry failed duplicate.
- Realtime recording duplicate detection.
- Cross-user dedup.
- Advanced race-condition handling if DB unique index is too risky.

## 5. Current system audit

### Backend inventory

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Meeting upload | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java` | Upload saves file to disk, validates extension/size, stores `title`, `audioPath`, `originalFileName`, `ownerUserId`, `language`, `createdAt`. | No audio hash, file size, duration, status, soft delete, rename, or duplicate lookup. |
| Meeting entity | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/entity/Meeting.java` | Entity has `id`, `title`, `audioPath`, `originalFileName`, `ownerUserId`, `createdAt`, `language`. | Missing `audioHash`, `fileSize`, `duration`, `deletedAt`, and any lifecycle/status fields. |
| Meeting read APIs | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java` | Supports `POST /meetings/upload`, `GET /meetings/{id}`, `GET /meetings` for owner-scoped recent meetings. | No search, filter, sort, patch/rename, or delete endpoint. |
| Meeting repository | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/repository/MeetingRepository.java` | Owner-scoped fetch by id and recent list by owner. | No query methods for search/filter/sort, soft delete, duplicate lookup, or title update. |
| Meeting DB schema | `demoRecordAUDIOMID/meeting-service/src/main/resources/db/migration/V1__init_schema.sql`, `V2__add_owner_user_id.sql`, `V3__add_original_file_name.sql`, `V4__add_language_to_meeting.sql` | Schema currently has `title`, `audio_path`, `owner_user_id`, `created_at`, `original_file_name`, `language`. | No `audio_hash`, `file_size`, `duration`, `deleted_at`, or status columns. |
| Processing upload | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java` | `/processing/upload` delegates file upload to AI service. `/processing/start` begins processing. | No duplicate guard for repeated audio upload. |
| Processing state | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java`, `JobStateStore.java` | Job state is tracked in Redis with `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, and related metadata. `claimIdempotency(fileId, meetingId)` exists for batch file idempotency. | Existing idempotency is fileId-based, not owner-scoped audio hash-based. It does not cover meeting re-upload dedupe. |
| AI service transcript/analysis | `demoRecordAUDIOMID/ai-service/app/main.py`, `app/pipeline.py`, `app/tasks.py`, `app/job_status_store.py` | Transcript fragments and analysis are persisted; analysis state uses Redis with cooldown and skip logic. | No meeting-level duplicate upload decision and no re-use by audio hash. |
| Analysis storage | `demoRecordAUDIOMID/ai-service/app/models.py` | `Transcript`, `TranscriptFragment`, `TranscriptCheckpoint`, `Analysis` exist. | No meeting upload metadata fields to support audio duplicate matching. |

### Frontend inventory

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| History screen | `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx` | Loads recent meetings, selected meeting detail, transcript, and saved analysis. | Search input is read-only; no filter, sort, rename, delete, or soft-delete actions. |
| History UI states | `FE-Audiomind/src/components/ui/EmptyState.tsx`, `LoadingState.tsx`, `ErrorState.tsx` | Generic empty/loading/error components already exist. | Meeting-specific copy and action affordances are not yet wired for management UX. |
| Upload screen | `FE-Audiomind/src/components/features/FeatureUpload.tsx` | Accepts file and language, shows status/error, submits upload. | No duplicate-upload banner, no retry/redirect message, no existing meeting reuse UI. |
| App orchestration | `FE-Audiomind/src/app/App.tsx` | Upload flow creates meeting, starts processing, then polls transcript/analysis. Realtime scene also exists. | Duplicate guard must be handled by backend response handling; FE has no current branching for duplicate reuse. |
| API service | `FE-Audiomind/src/services/api.ts` | Exposes meeting upload, processing start/status, transcript and analysis reads, meeting list/detail reads. | No meeting rename/delete/list query params and no duplicate metadata response types. |
| Meeting model | `FE-Audiomind/src/types/index.ts` | Meeting type has `id`, `title`, `audioPath`, `createdAt`, optional `originalFileName`, `ownerUserId`, `language`. | No `status`, `deletedAt`, `audioHash`, `fileSize`, or `duration` in FE model. |

### Data model inventory

| Data | Current storage | Needed for duplicate guard | Gap |
| ---- | --------------- | -------------------------- | --- |
| Audio identity | File stored on disk as a generated name; original filename stored in meeting row. | `audioHash = SHA-256(file bytes)` plus owner-scoped lookup. | Hash missing, so filename-only reuse would be unsafe. |
| Ownership | `owner_user_id` on meeting row; owner-scoped reads already enforced. | Keep owner scope as dedupe boundary. | Good base, but duplicate guard must remain owner-scoped. |
| Processing status | Redis job state in processing/ai service. | Duplicate lookup should return existing meeting with status if processing/completed/failed. | Meeting row does not yet expose lifecycle status. |
| Transcript/analysis completion | Redis plus persisted transcript/analysis in ai-service. | Completed duplicate should reuse existing transcript and analysis. | No meeting-level join key for dedupe reuse. |
| Soft delete | Not present. | Exclude deleted rows from duplicate lookup, with explicit restore policy if needed later. | Deletion semantics undefined. |

### API inventory

| Endpoint | Method | Current behavior | Needed change |
| -------- | ------ | ---------------- | ------------- |
| `/meetings/upload` | `POST` | Creates a meeting and stores file. | Must return duplicate metadata when reusing existing meeting, or create new meeting only when no active duplicate exists. |
| `/meetings` | `GET` | Returns recent owner meetings. | Needs search/filter/sort and soft-delete exclusion support. |
| `/meetings/{id}` | `GET` | Returns owner-scoped meeting detail. | Needs to honor deleted state and support management UX. |
| `/processing/start/{meetingId}` | `POST` | Starts processing for a given meeting. | Should not be used to rerun completed duplicates by default. |
| `/processing/{meetingId}/analysis/saved` | `GET` | Returns saved analysis only. | Keep as read-only path; duplicate reuse should point here or the existing meeting detail. |

## 6. Duplicate upload design

Recommended source of truth:

- Backend computes `audioHash = SHA-256(file bytes)`.
- FE pre-hash may be used later for UX only, not security.
- Duplicate key: `ownerId + audioHash`.
- Optional extra checks:
  - fileSize
  - duration
  - mimeType
  - originalFilename only for display, not identity

Flow:

1. New upload arrives.
2. Backend computes `audioHash`.
3. Check existing non-deleted meeting/audio for same owner.
4. If completed transcript + completed analysis exists:
   - return existing meetingId
   - return `duplicate=true`
   - return `reused=true`
   - do not run STT
   - do not call Gemini
5. If existing meeting is processing:
   - return existing meetingId
   - return `duplicate=true`
   - return `status=processing`
   - do not create a new job
6. If existing meeting failed:
   - return existing meetingId
   - return `status=failed`
   - do not auto-rerun unless user explicitly retries later
7. If no duplicate exists:
   - create new meeting
   - run upload pipeline normally

### Status source clarification

- `processing` can be resolved from active Redis/job state when available.
- `completed` requires transcript + analysis completed.
- `failed` must not be reused as `completed`.
- If status certainty is low, FE must show an explicit fallback message instead of silently treating as completed.

### Old records clarification

- Old meetings without `audioHash` cannot be deduplicated safely.
- MVP deduplicates only new uploads after hash/field support is added.
- Do not backfill legacy `audioHash` unless later phases explicitly require it.

## 7. Meeting Management UX

MVP:

- Search by title/original filename
- Filter by status/language/source if available
- Sort by created date
- Rename meeting
- Soft delete meeting
- Empty/loading/error polish
- Duplicate upload banner:
  - completed: "This audio was already analyzed. Opening previous result."
  - processing: "This audio is already being processed."
  - failed: "This audio was processed before but failed."

## 8. API plan

Use existing conventions if available.

Potential endpoints:

- `GET /meetings?query=&status=&language=&sort=`
- `PATCH /meetings/{id}` for rename
- `DELETE /meetings/{id}` for soft delete

Upload response should include duplicate metadata when applicable:

```json
{
  "duplicate": true,
  "reused": true,
  "existingMeetingId": 3,
  "status": "completed"
}
```

## 9. Data model plan

Needed fields if absent:

- `audioHash`
- `fileSize`
- `duration`
- `originalFilename`
- `source`
- `deletedAt`
- `status`

Recommended DB rule:

- Unique or guarded lookup by `ownerId + audioHash` for non-deleted records if feasible.
- If DB unique constraint is too risky for MVP, implement guarded lookup first and document race-condition limitation.

Do not design cross-user dedup in MVP.

## 10. Race condition plan

Consider:

- two same uploads arrive at nearly the same time
- duplicate check passes before either insert commits
- can create duplicate jobs

Mitigation options:

- DB unique constraint/index if feasible
- transaction/lock if repo has pattern
- fallback detection after insert if unique violation happens
- document limitation if not implementable in MVP

## 11. Risk matrix

| Risk | Impact | Likelihood | Mitigation |
| ---- | ------ | ---------- | ---------- |
| Old meetings missing audioHash | Duplicate guard cannot match historical uploads | Medium | Only dedupe records with audioHash; document legacy fallback |
| Filename-based duplicate is unsafe | Different files can share a name | High | Use SHA-256 file bytes as source of truth |
| Deleted meeting duplicate behavior unclear | User may be redirected to hidden/deleted record | Medium | Exclude deleted records in MVP; decide restore later |
| Failed analysis reused incorrectly | User may see failed result as completed | High | Treat failed as failed; do not mark reused completed |
| Duplicate processing race condition | Two same uploads may create two jobs | Medium | Prefer unique ownerId+audioHash for non-deleted rows or transactional guard |
| Cross-user dedup privacy risk | One user could infer another user’s upload | High | No cross-user dedup in MVP |
| STT/Gemini still triggered by wrong path | Cost still duplicated | High | Add tests/log smoke proving duplicate completed skips STT/Gemini |
| FE redirect confusing | User may not understand why old result opens | Medium | Show duplicate/reuse banner |

## 12. Acceptance criteria

- Same user uploads same audio twice.
- Second upload does not run STT if first completed.
- Second upload does not call Gemini if completed analysis exists.
- Duplicate response points to existing meeting.
- If first meeting is processing, second upload shows processing state.
- If first meeting failed, second upload does not silently reuse as completed.
- Duplicate completed upload does not call STT.
- Duplicate completed upload does not call Gemini.
- Search/filter/sort works on meeting list.
- Rename works and persists.
- Deleted meeting does not appear in normal list.
- User cannot access another user’s meeting.
- No STT routing/default/multi changes.
- No Gemini schema rewrite.
- No realtime pause/resume behavior change.

## 13. Validation plan

Implementation phase should run:

- backend tests for duplicate upload guard
- backend tests for owner-scoped rename/delete/list
- FE tests for search/filter/rename/delete states
- FE build
- contract/client validation if API contract changes

Manual browser smoke:

1. Upload audio A.
2. Wait for transcript + analysis completed.
3. Upload same audio A again.
4. Confirm second upload reuses existing meeting.
5. Confirm no STT call on duplicate completed upload.
6. Confirm no Gemini call on duplicate completed upload.
7. Confirm logs show no STT/Gemini call for the second upload.
8. Rename meeting.
9. Search renamed meeting.
10. Delete meeting.
11. Confirm deleted meeting hidden from list.

## 14. Open questions

- Should delete be soft delete or hard delete?
- If user deletes a meeting, should duplicate upload restore it or create a new one?
- Should duplicate detection apply to realtime recordings too?
- Should duplicate detection allow same audio for different users?
- Should user see "This file was already analyzed" confirmation before redirect?
- Should retry failed duplicate be in 7N or a later phase?
