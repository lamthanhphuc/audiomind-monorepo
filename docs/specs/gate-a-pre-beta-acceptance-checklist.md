# Gate-A Pre-Beta Acceptance Checklist

Updated: 2026-06-12

This checklist combines the required pre-beta gates for:

- `7T-QA-F9-R1` through `7T-QA-F9-R6`
- `7T-QA-F10`
- `7T-ErrorUX-A`
- `7T-Validation-A`
- `Gate-A-QA`

Do not merge beta code until every required row is resolved or explicitly waived by the user with a recorded reason.

## 1. F9 Gate 5 Checklist

| Item | Expected result | Required evidence | Status |
| --- | --- | --- | --- |
| No speech realtime meeting | `NO_TRANSCRIPT`, no analysis, not failed, Meeting History not stuck processing. | `HYDRATION_FINALIZED_EMPTY_CONFIRMED`, `REALTIME_ANALYSIS_SKIPPED reason=no_transcript`, no Gemini request. | Pending |
| Normal sensitivity + noise suppression on + speech | Live transcript or final fallback transcript; no silent empty success. | `REALTIME_AUDIO_CHUNK_OBSERVED`, `LIVE_TRANSCRIPT_RENDERED` or fallback markers, row count/status. | Pending |
| Normal sensitivity + noise suppression off + speech | Same as above. | Chunk integrity status and transcript/fallback markers. | Pending |
| High sensitivity + noise suppression on + speech | Transcript appears live or controlled partial/fallback path. | Chunk sizes above tiny threshold after speech or controlled error. | Pending |
| High sensitivity + noise suppression off + speech | Transcript appears live or controlled partial/fallback path. | Backend rows and FE state agree. | Pending |
| Deepgram fail fallback | WebM continuation is not blindly reconnected; fallback succeeds or controlled error. | `STT_SOCKET_TERMINAL_CLOSE`, `STT_RECONNECT_BLOCKED_WEBM_CONTINUATION`, `STT_FINAL_AUDIO_FALLBACK_*`. | Pending |
| Re-analyze existing v2 | Rerun preserves `gemini-business-v2`. | `ANALYSIS_VERSION_SELECTED`, `RERUN_ANALYSIS_VERSION_PRESERVED`, UI shows v2. | Pending |
| Search `ea` | Does not match inside `team`. | Search test/manual result with safe metadata only. | Pending |
| Search `email FPT` | Relevant email/FPT transcript segment still matches. | Search result. | Pending |
| Search `ke hoach` | Matches `kế hoạch`. | Search result. | Pending |
| Search `fpt` | Matches `FPT`. | Search result. | Pending |
| Export after rerun | Uses saved v2 analysis, no export-time Gemini, evidence confidence applied. | DOCX/action-plan output and no Gemini logs. | Pending |

## 2. F10 Grouped Action Plan Checklist

| Item | Expected result | Required evidence | Status |
| --- | --- | --- | --- |
| Grouped action plan schema | Saved analysis exposes `groupedActionPlan` plus legacy `action_items`, `businessActionItems`, and `actionItems`. | AI/processing/FE tests assert all fields remain readable. | Pending |
| Grouped cache feature set | Old v2 cache without grouped plan is not reused for grouped-capable request. | Cache/idempotency test with `analysisFeatureSet=grouped-action-plan-v1` or grouped-aware schema version. | Pending |
| Public field name | Public responses emit `groupedActionPlan` only, not duplicate snake/camel variants. | API/FE tests assert `groupedActionPlan` present and public `grouped_action_plan` absent. | Pending |
| Flat task mapping | Grouped items map to `action_items` or transcript evidence; unsupported new tasks cannot be `SUPPORTED`. | AI normalization/evidence tests fail unsupported grouped-only `SUPPORTED` task. | Pending |
| Hackathon-like meeting grouping | Output has clear functional sections suitable for sharing. | Safe sample assertion checks section titles/counts without raw transcript logs. | Pending |
| Non-Hackathon meeting grouping | Output uses domain-appropriate sections and does not reuse Hackathon headings. | AI test fixture with different domain. | Pending |
| Low-task meeting | Empty or `Công việc chung` fallback; no invented tasks. | AI normalization test and FE empty-state test. | Pending |
| FE grouped display | Meeting detail renders grouped sections, subtasks, notes, and confidence states. | FE component tests. | Pending |
| Legacy saved analysis | Old analysis without `groupedActionPlan` returns fallback/empty 200 and does not crash FE/export. | FE/export fallback tests for flat-items fallback and no-items empty state. | Pending |
| Action-plan JSON preview | JSON preview exposes `groupedActionPlan` or deterministic fallback. | Processing controller/service test. | Pending |
| Grouped DOCX export | DOCX includes `CÔNG VIỆC CẦN LÀM THEO NHÓM CHỨC NĂNG`. | Processing DOCX test. | Pending |
| No export-time Gemini | Grouped preview/export uses saved analysis only. | Mock/fail provider call test proves no Gemini/lazy analysis. | Pending |
| Grouped evidence confidence | Item/subtask evidence is verified only by Search-A persisted transcript matches. | Weak/wrong evidence rejected in export tests. | Pending |
| Copyable grouped output | FE can copy Markdown/plain-text grouped plan with fallback behavior. | Pure formatter or component test preserves order, subtasks, Vietnamese/proper nouns, and does not claim unverified evidence. | Pending |
| Long grouped output capped | Over-limit sections/items/subtasks/notes/keywords/source ids are deterministically capped. | AI normalizer and export/FE stress fixtures. | Pending |
| No grouped payload logs | Runtime/source logs do not include full grouped payload, section titles, item descriptions, subtasks, notes, evidence keywords, owners, or deadlines. | Log-safety scan/test with docs/tests exceptions noted. | Pending |
| Version guard | Re-analyze preserves/produces v2+ grouped analysis; no v1 downgrade. | `RERUN_ANALYSIS_VERSION_PRESERVED` and saved metadata assertion. | Pending |
| F10 dependency gate | F10 export/evidence is not signed off until F9 R1/R5/R6 pass. | Gate report shows R1 re-analyze/version, R5 search boundary, and R6 evidence confidence green or explicitly waived. | Pending |

## 3. ErrorUX-A Checklist

| Item | Expected result | Required evidence | Status |
| --- | --- | --- | --- |
| Mic denied | User sees microphone permission guidance. | `MIC_PERMISSION_DENIED`, `CHECK_MIC`, traceId if backend involved. | Pending |
| Upload too large | User sees max-size message. | `UPLOAD_TOO_LARGE`, no provider call. | Pending |
| Unsupported file | User sees unsupported audio format message. | `UNSUPPORTED_AUDIO_TYPE`, no provider call. | Pending |
| Owner forbidden | User sees permission error, not 500. | `OWNER_FORBIDDEN`, HTTP 403. | Pending |
| Analysis busy | User sees `AI đang bận, vui lòng thử lại sau.` | `ANALYSIS_BUSY`, retryable true. | Pending |
| Export missing analysis | User sees analysis required, not generic fail. | `EXPORT_ANALYSIS_REQUIRED`, no Gemini. | Pending |
| Invalid audio capture | User sees mic/audio capture guidance. | `INVALID_AUDIO_CAPTURE` or `FAILED_AUDIO_CAPTURE`, no no-speech classification. | Pending |
| Grouped plan unavailable | User sees empty/fallback state, not generic failure. | `GROUPED_ACTION_PLAN_UNAVAILABLE`, no Gemini. | Pending |
| Grouped plan invalid/export failed | User sees structured safe error. | `GROUPED_ACTION_PLAN_INVALID` or `GROUPED_ACTION_PLAN_EXPORT_FAILED`, traceId, no raw payload. | Pending |

## 4. Validation-A Checklist

| Item | Expected result | Required evidence | Status |
| --- | --- | --- | --- |
| Empty upload | Rejected before provider call. | `EMPTY_FILE`, no Deepgram/Gemini. | Pending |
| Bad MIME | Rejected before provider call. | `UNSUPPORTED_AUDIO_TYPE`. | Pending |
| Oversized upload | Rejected before provider call. | `UPLOAD_TOO_LARGE`. | Pending |
| One-character search | FE blocks when possible; backend rejects if called. | `QUERY_TOO_SHORT`, no raw query logs. | Pending |
| Re-analyze double click | One rerun/idempotent result. | No duplicate Gemini calls. | Pending |
| Export before analysis | Controlled 409. | `EXPORT_ANALYSIS_REQUIRED`, no lazy Gemini. | Pending |
| Stale realtime session | Rejected/ignored safely. | No stale meeting state update. | Pending |
| Grouped plan caps | Oversized sections/items/subtasks normalized or rejected. | `GROUPED_ACTION_PLAN_INVALID` or normalized bounded output. | Pending |
| Grouped export provider-free | Missing/legacy grouped data does not trigger Gemini. | No provider call assertion. | Pending |

## 5. Security And Log-Safety Checklist

| Item | Expected result | Required evidence | Status |
| --- | --- | --- | --- |
| No raw audio | Runtime/source logs do not contain raw audio or byte dumps. | Log-safety scan passed. | Pending |
| No raw transcript | Runtime/source logs do not contain raw transcript text. | Log-safety scan passed. | Pending |
| No raw prompt | Runtime/source logs do not contain prompt text. | Log-safety scan passed. | Pending |
| No API key/JWT/token | Runtime/source logs do not contain secrets or Authorization values. | Log-safety scan passed. | Pending |
| No full grouped payload | Runtime/source logs do not contain grouped plan titles/descriptions/subtasks/notes/keywords/owners/deadlines. | Grouped log-safety scan passed with docs/tests exceptions. | Pending |
| No debug zip staged | Debug zips/folders are untracked or removed before merge. | `git status --short`, no staged debug artifacts. | Pending |
| No browser logs staged | Browser logs are not staged. | `git diff --cached --name-only`. | Pending |

Forbidden strings to include in log/source scan:

- `first16hex`
- `base64`
- `Authorization`
- `Bearer `
- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`
- `raw transcript`
- `raw audio`
- `byte dump`
- `deviceId`
- `prompt text`
- `Gemini raw response`

Docs and `.env.example` may mention variable names without secret values. Runtime logs must not contain secret values or raw user content.

## 6. Test Commands

Use normal user-run commands here. Agents may use `rtk` internally for short command output, but these commands are the source of truth for the beta gate.

FE:

```powershell
cd D:\Bin\EXE101\phase3-worktree\FE-Audiomind
npm test -- --run src/app/App.test.tsx
npm test -- --run src/hooks/useRealtimeMeetingStream.test.tsx
npm test -- --run src/components/realtime/AudioRecorderButton.test.tsx
npm test -- --run src/components/features/RealtimeDashboardScene.test.tsx
npm test -- --run src/components/features/MeetingHistoryScene.test.tsx
npm test -- --run src/services/api.test.ts
npm test -- --run --silent
npm run build
```

Processing:

```powershell
cd D:\Bin\EXE101\phase3-worktree\demoRecordAUDIOMID\processing-service
.\mvnw.cmd "-Dtest=MeetingWebSocketHandlerTest,ProcessingServiceTest,AIServiceClientTest" test
.\mvnw.cmd test
```

AI service:

```powershell
cd D:\Bin\EXE101\phase3-worktree\demoRecordAUDIOMID\ai-service
python -m pytest tests -q
```

Docker smoke:

```powershell
cd D:\Bin\EXE101\phase3-worktree
docker compose --env-file infra/.env `
  -f infra/docker-compose.dev.yml `
  -f infra/docker-compose.mvp.yml `
  up -d --build --force-recreate web processing-api ai-api meeting-api
```

## 7. Final Beta Smoke Sign-Off

Before merge, record:

- Test command results.
- Manual smoke outcomes for each F9 row.
- F10 grouped action plan outcomes, including old-analysis fallback and no export-time Gemini.
- F9 R1/R5/R6 status before F10 export/evidence sign-off.
- ErrorUX-A outcomes for each required error case.
- Validation-A outcomes for invalid request cases.
- Log-safety scan result.
- Git status showing no staged debug artifacts.
- Any waived item with user-approved reason.

Gate-A cannot pass if F9 R1, R5, or R6 are pending while F10 export/evidence is marked done. Any exception requires an explicit user-approved waiver with reason, date, scope, and follow-up owner.
