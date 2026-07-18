# Phase 2 — Implementation Report

**Verdict (this session):** **Ready to merge**

Third post-review remediation completed. All mandatory gates green.

## A. Git

| Item | Value |
|------|--------|
| Branch | `feature/phase2-subject-synthesis-study-artifacts` |
| Base | `origin/main` @ `e7ba389` |
| Prior HEAD | `2e37baa` (27 commits) |
| New commits | third post-review remediation (see log) |
| History | No reset / rebase / force-push of prior commits |

## B. AI full suite

| Item | Detail |
|------|--------|
| Command | `pytest` (`demoRecordAUDIOMID/ai-service`) |
| Result | **571 passed, 0 failed, 23 skipped**, exit **0** |

## K. Post-review remediation

(See prior section K for first remediation.)

## L. Second post-review remediation

(See prior section L: retry state machine, migration 014, Beat, source hash, savepoints, regenerate null synthesisId, empty-subject stale, MCQ IDs, reducer multi-round, evidence pairs.)

## M. Third post-review remediation

### M.1 Quota idempotency architecture
- Durable ledger in **user-service**: table `quota_consumption` with `UNIQUE(owner_user_id, idempotency_key)` (Flyway `V11`).
- Keys: `subject-synthesis:{id}:quota`, `study-artifact:{id}:quota` (new version → new id → new key).
- Same key: charge once; concurrent races resolve via unique-constraint recovery.
- DENIED keys re-evaluate after top-up (not permanently locked).
- Processing `UserQuotaClient.consume(..., idempotencyKey)` per newlyCreated id.
- AI `confirm-quota` remains idempotent when `quota_confirmed_at` already set.

### M.2 ALL_READY / EXPLICIT regenerate
- ALL_READY regenerate passes empty `meetingIds`; processing resolves current subject membership.
- EXPLICIT regenerate keeps stored explicit meeting list (validated still in subject).
- `normalizeMode` no longer flips empty+ALL_READY to EXPLICIT.

### M.3 Dispatch attempt accounting
- Every successful `claim_dispatch_*` increments `dispatch_attempt_count` and refuses when `>= max`.
- Broker failure does **not** double-increment; sets error/backoff; `DISPATCH_EXHAUSTED` at max.
- Reconciliation uses the same claim path → orphan redispatches are bounded.

### M.4 Membership pre-worker guard
- `fetch_subject_meeting_ids` via meeting-service (`MEETING_SERVICE_BASE_URL` + internal token).
- ALL_READY: current membership vs `subject_membership_hash` / source hash.
- EXPLICIT: meeting left subject → STALE; new meetings outside selection do not stale.
- Migration **015**: `subject_membership_hash` on synthesis + artifact.

### M.5 Reducer hard token ceiling
- `assert_prompt_within_limit` before every Gemini call.
- Oversized intermediate compacted/chunked; segment-id cap; max reducer rounds = 8.
- `PROMPT_TOKEN_LIMIT_EXCEEDED` if still over limit.

### M.6 Exception retry whitelist
- Retry only transient provider/network (timeout, connection, 429, 5xx).
- `TypeError`/`AttributeError`/`KeyError`/`ValueError` → `PROGRAMMING_ERROR` FAILED, no requeue.
- Other unknown → `INTERNAL_ERROR` FAILED unless classified transient.

### M.7 Migrations
- AI Alembic **015** (membership hash): upgrade/downgrade lifecycle PASS.
- User Flyway **V11** (`quota_consumption` ledger).

### M.8 Tests / smoke
- New: `test_phase2_third_remediation.py`.
- Technical smoke covers quota redispatch attempts, programming-error no-retry, confirm-quota.
- QuotaServiceTest concurrent same-key; StudyGenerationControllerTest ALL_READY/EXPLICIT regenerate.

## H. Full matrix

| Module | Command | Exit | Passed | Failed | Skipped | Result |
|--------|---------|------|--------|--------|---------|--------|
| AI | `pytest` | 0 | 571 | 0 | 23 | PASS |
| Processing | `.\mvnw.cmd -q test` | 0 | suite | 0 | — | PASS |
| Meeting | `.\mvnw.cmd -q test` | 0 | suite | 0 | — | PASS |
| User/Quota | `mvnw -pl user-service test` | 0 | suite | 0 | — | PASS |
| FE lint | `npm run lint` | 0 | — | — | — | PASS |
| FE test | `npm run test` | 0 | 727 | 0 | — | PASS |
| FE build | `npm run build` | 0 | — | — | — | PASS |
| Contracts | validate/generate/typecheck/check:openapi | 0 | — | — | — | PASS |
| Migration | Alembic through **015** (+ Flyway V11 added) | 0 | — | — | — | PASS |
| `git diff --check` | origin/main...HEAD | 0 | — | — | — | PASS |

## Smoke

| Kind | Result |
|------|--------|
| Technical fake-provider smoke | **PASS** |
| Real Gemini smoke | **NOT RUN** |

## I. Remaining risks

1. Real Gemini staging smoke still recommended.
2. Meeting-service membership path may require JWT vs internal-token alignment in some envs — verify staging wiring of `MEETING_SERVICE_BASE_URL`.
3. Concurrent multi-artifact race still strongest on Postgres (`PHASE2_CONCURRENT_DATABASE_URL`).

## J. Status

**Ready to merge:** **Yes**
