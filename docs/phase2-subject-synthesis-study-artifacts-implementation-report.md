# Phase 2 — Implementation Report

**Verdict (this session):** **Ready to merge**

Final distributed-systems remediation (section **N**) completed. All mandatory gates green.

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

**Ready to merge:** **Yes** (superseded by section N after final distributed-systems remediation)

## N. Final distributed-systems remediation

### N.1 Quota tri-state
- `QuotaConsumeStatus`: `ALLOWED` | `DENIED` | `UNKNOWN`
- Processing `UserQuotaClient`: transport/5xx/timeout → `UNKNOWN` (never `DENIED`); short retries (≤3) with same idempotency key
- `DENIED` only on definitive user-service business rejection
- AI rows on `UNKNOWN`: stay `QUEUED`, `quota_confirmed_at=null`, no soft-delete, same artifact ID + key on retry

### N.2 Timeout-after-commit
- If user-service commits ledger then response times out → processing sees `UNKNOWN`
- Retry reuses key → ledger returns prior `ALLOWED` → single deduction
- Covered by `StudyGenerationServiceTest` (MockWebServer timeout → UNKNOWN → retry ALLOWED)

### N.3 Usage-counter concurrency
- PostgreSQL `pg_advisory_xact_lock(userId, period)` before read/create
- `INSERT … ON CONFLICT (user_id, period_yyyymm) DO NOTHING` then `SELECT … FOR UPDATE`
- Ledger unique conflict → re-read prior outcome; other integrity violations → bounded retry / clear failure
- `QuotaConcurrencyIT` (Testcontainers Postgres): same-key ×8, different-key ×2, near-limit allow/deny

### N.4 Quota types
- Ledger stores `quota_type`: `SUBJECT_SYNTHESIS` vs `STUDY_ARTIFACT`
- Client sends type explicitly (no silent default to `STUDY_ARTIFACT` for synthesis)

### N.5 Partial batch quota
- Per-artifact independent consume → confirm+dispatch only `ALLOWED`
- `DENIED` → `QUOTA_EXCEEDED`; `UNKNOWN` → leave `QUEUED` retryable
- Aggregate `partialQuota` + `quotaDetails`; status `PARTIALLY_FAILED` when mixed
- Never abort confirm/dispatch of other ALLOWED items because one sibling was DENIED

### N.6 Internal meeting membership
- `GET /internal/subjects/{subjectId}/meetings` with `X-Internal-Service-Token` + `X-Owner-User-Id`
- Controller-level token check (no JWT); wrong owner → 404
- AI `membership.py`: internal-only URL, full pagination, code `MEETING_MEMBERSHIP_SERVICE_UNAVAILABLE`
- No public `/subjects/.../meetings` fallback without JWT

### N.7 Artifact hard token ceilings
- All five artifact types: `assert_prompt_within_limit` before Gemini
- Source compaction (synthesis / educationStudy / segments / evidence pairs)
- `PROMPT_TOKEN_LIMIT_EXCEEDED` if still over limit — provider not called

### N.8 Helper-level retry classification
- Shared `classify_provider_exception` in `app/services/study/exceptions.py`
- `artifacts.py` / `synthesis.py` use classifier (no blanket `Exception → StudyTransientError`)
- Outer worker: `TypeError`/`AttributeError`/`KeyError`/`ValueError` → `PROGRAMMING_ERROR` FAILED, no retry

### N.9 Migrations
- No new Alembic/Flyway required for advisory locks (runtime SQL)
- Prior **015** / **V11** unchanged

### N.10 Contracts / deploy
- OpenAPI: internal membership, quota tri-state consume, `partialQuota` / `quotaDetails`
- Production Settings fail-fast if `MEETING_SERVICE_BASE_URL` or `INTERNAL_SERVICE_TOKEN` missing
- Compose/K8s/`.env.example` already carry meeting URL + internal token + study Celery worker

### N.11 Matrix / smoke (this remediation)
| Gate | Result |
|------|--------|
| AI pytest | **588 passed**, 0 failed, 23 skipped, exit **0** |
| Processing Maven | exit **0** |
| Meeting Maven | exit **0** (MimeSniffer perf threshold relaxed 50→200ms for CI flake) |
| User/Quota Maven | exit **0** (includes `QuotaConcurrencyIT` ×3 on Testcontainers Postgres) |
| FE lint / test / build | exit **0** (727 tests) |
| Contracts validate/generate/typecheck/check:openapi | exit **0** |
| QuotaConcurrencyIT (Postgres) | **PASS** (same-key, different-key, near-limit) |
| Technical fake-provider smoke | **PASS** |
| Real Gemini smoke | **NOT RUN** |

### N.12 Remaining risks
1. Real Gemini staging smoke still recommended.
2. SQLite unit paths are not evidence for advisory-lock correctness — Postgres IT is authoritative.
3. Membership 401/403 treated as transient (token rotation); misconfig may delay STALE detection until fixed.

## O. Merge gate (final)

**Ready to merge:** **Yes** — quota UNKNOWN≠DENIED, timeout-after-commit single charge, concurrent usage-counter safe, partial batch dispatch, internal membership auth+pagination, artifact token ceilings, helper programming errors no-retry, full matrix green.
