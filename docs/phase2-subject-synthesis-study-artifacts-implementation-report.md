# Phase 2 — Implementation Report

**Verdict (this session):** see **U. Full-stack staging deployment closure** (latest gate).

Final distributed-systems remediation (section **N**) and runtime deployment closure (**Q**) completed. Java JWT / Secret ownership closure is section **R**.

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
- `QuotaConcurrencyTest` (Testcontainers Postgres): same-key ×8, different-key ×2, near-limit allow/deny

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
| AI pytest | **614 passed**, 0 failed, 23 skipped, exit **0** |
| Processing Maven | exit **0** |
| Meeting Maven | exit **0** (MimeSniffer perf threshold relaxed 50→200ms for CI flake) |
| User/Quota Maven | exit **0** (includes `QuotaConcurrencyTest` ×3 on Testcontainers Postgres in default `mvn test`) |
| FE lint / test / build | exit **0** (727 tests) |
| Contracts validate/generate/typecheck/check:openapi | exit **0** |
| QuotaConcurrencyTest (Postgres) | **PASS** (same-key, different-key, near-limit) |
| AAlembic upgrade → downgrade -1 → upgrade | **PASS** (head **015**) |
| K8s YAML parse | **PASS** (no live cluster; `yaml.safe_load_all`) |
| Technical fake-provider smoke | **PASS** |
| Real Gemini smoke | **NOT RUN** |

### N.12 Remaining risks
1. Real Gemini staging smoke still recommended.
2. SQLite unit paths are not evidence for advisory-lock correctness — Postgres IT is authoritative.
3. Membership 401/403 treated as transient (token rotation); misconfig may delay STALE detection until fixed.

## O. Deployment and validation finalization

### O.1 K8s token + service URL wiring
- Every Phase-2-critical deployment (`meeting-api`, `processing-api`, `user-api`, `ai-api`, `celery-worker`, `celery-beat`) wires `INTERNAL_SERVICE_TOKEN` via `secretKeyRef` → `audiomind-secrets`.
- `processing-api`: `AUDIOMIND_USER_API_BASE_URL=http://user-api:8083` (not localhost); `AUDIOMIND_AI_API_BASE_URL` from configMap.
- `ai-api` / `celery-worker` / `celery-beat`: `APP_ENV=production`, `MEETING_SERVICE_BASE_URL=http://meeting-api:8081`, `INTERNAL_SERVICE_TOKEN` secret.
- Guard tests assert Phase-2 USER/MEETING/AI base URL literals in `core-deployments.yaml` never use `localhost`.
- Compose (`infra/docker-compose.dev.yml`, `infra/docker-compose.mvp.yml`): `ai-api`, `celery-worker`, and `celery-beat` each include `MEETING_SERVICE_BASE_URL` + `INTERNAL_SERVICE_TOKEN` (beat confirmed).

### O.2 Celery Beat production startup
- `test_celery_beat_production_config.py`: with valid production Settings (`database_url` non-local, `ollama` non-local, CORS without localhost, Gemini key, meeting URL, internal token), `app.celery_app` loads and `beat_schedule` contains `study-generation-reconcile`.
- Missing `MEETING_SERVICE_BASE_URL` or `INTERNAL_SERVICE_TOKEN` → Settings validation fails (fail-fast before Beat/worker boot).
- `celery-beat-deployment` replicas remain `1`.

### O.3 Prompt ceiling + provider exception classification
- Full prompt ceiling: system + user combined tokens gated (`PROMPT_TOKEN_LIMIT_EXCEEDED`, no provider call).
- Malformed provider JSON → validation error codes, status `FAILED`, no Celery requeue.
- Valid JSON / wrong schema → validation `FAILED`, no requeue.
- Helper `TypeError` → `PROGRAMMING_ERROR` `FAILED`, no requeue; timeouts/429 remain transient.

### O.4 Quota retry + Postgres concurrency + partial batch
- Quota 4xx (auth / business DENIED): no retry as ALLOWED; transport/5xx/timeout → `UNKNOWN` with short same-key retry — covered by Java `UserQuotaClientTest` / `StudyGenerationServiceTest`.
- Postgres concurrency in default user-service gate: `QuotaConcurrencyTest` (Testcontainers).
- Partial batch: `StudyGenerationServiceTest` (`PARTIALLY_FAILED`, per-item confirm+dispatch).

### O.5 Membership HTTP integration
- `InternalSubjectControllerIntegrationTest` (MockMvc): valid token → 200 JSON with `items` / `page` / `pageSize` / `total` / `totalPages`; bad/missing token → 401; wrong owner → 404 via controller + `GlobalExceptionHandler`.
- AI client unit coverage remains in `test_membership.py` (valid parse, 404 validation, pagination).

### O.6 Matrix / smoke (this finalization)
| Gate | Result |
|------|--------|
| Full AI pytest | **614 passed**, 0 failed, 23 skipped, exit **0** |
| Processing / Meeting / User Maven | exit **0** (`QuotaConcurrencyTest` ×3 in default gate) |
| FE lint/test/build | exit **0** (727) |
| Contracts | exit **0** |
| Meeting `InternalSubjectControllerIntegrationTest` + unit | **PASS** |
| Technical fake-provider smoke | **PASS** (evidence checklist in `test_phase2_finalization_evidence_smoke`) |
| Real Gemini smoke | **NOT RUN** |

### O.7 Remaining risks
1. Real Gemini staging smoke still recommended before production cutover.
2. Compose/dev still allows empty `GOOGLE_INTERNAL_SERVICE_TOKEN` defaults — operators must set a real token for membership to work.
3. `kubectl apply --dry-run` needs a live API server; YAML parse + deployment guard tests are the offline substitute.

## P. Merge gate (final)

**Ready to merge:** **Superseded by section Q** — earlier gates remain necessary but insufficient without component-scoped Settings, rendered-manifest startup, quota 5xx retry, and required Postgres concurrency CI.

## Q. Runtime deployment closure

### Q.1 `APP_COMPONENT` architecture
| Component | Env | Validates in production |
|-----------|-----|-------------------------|
| API | `APP_COMPONENT=api` (default if unset) | DB, Redis/broker, CORS (no localhost), internal token, meeting-service URL, analysis provider + credentials, study queue, HF diarization when enabled |
| Worker | `APP_COMPONENT=worker` (explicit in K8s) | DB, Redis/broker, meeting URL, internal token, analysis provider + credentials, `study_generation` queue — **no CORS** |
| Beat | `APP_COMPONENT=beat` (explicit in K8s) | Broker/Redis URLs non-local only — **no CORS, Gemini, meeting URL, or internal token** |

### Q.2 Provider source of truth
- **SoT:** `ANALYSIS_PROVIDER` (`gemini` \| `ollama` \| `fake` only in non-prod).
- If both `AI_PROVIDER` and `ANALYSIS_PROVIDER` are set and differ → fail-fast.
- Production K8s: `ANALYSIS_PROVIDER=gemini` + `GEMINI_API_KEY` from `audiomind-secrets` on **ai-api** and **celery-worker** only.
- Beat does not receive provider env/secrets.

### Q.3 K8s base / overlays
- Base: `APP_COMPONENT`, Gemini wiring (api/worker), meeting URL + internal token (api/worker); **APP_ENV removed from base**.
- Overlay `app-env-patch.yaml`: `dev=development`, `staging/prod=production`.
- CORS: staging `https://staging.audiomind.example`, prod `https://app.audiomind.example`, dev may use localhost.
- Secrets templates include `GEMINI_API_KEY` / `INTERNAL_SERVICE_TOKEN` placeholders (`REPLACE_ME*`); no real secrets committed.

### Q.4 Rendered manifest Settings startup
- Test: `tests/test_k8s_rendered_component_settings.py` — kustomize each overlay → resolve env → `Settings()` for api/worker/beat.
- Offline structural script: `scripts/validate-rendered-k8s.py` (selectors, dup env/ports, ConfigMap refs, Beat replicas=1).
- `kubectl apply --dry-run=client` on this host still probes a live API/CRD discovery endpoint and fails offline; structural + Settings tests are the merge gate substitute.

### Q.5 Quota HTTP 500 retry
- `UserQuotaClient`: retryable = `429 || (500..599)`; 4xx definitive (except 429) → single attempt; never map 5xx → DENIED.

### Q.6 Required PostgreSQL concurrency CI gate
- Local default: soft-skip without Docker (`@Testcontainers(disabledWithoutDocker=true)` still allowed for DX).
- Required: `REQUIRE_POSTGRES_CONCURRENCY_TESTS=true` and/or Maven `-Pquota-postgres-it` → Docker missing **fails**; CI job `quota-postgres-concurrency` + `scripts/verify-quota-concurrency-results.mjs` asserts tests=3, skipped=0.

### Q.7 Membership cross-service contract smoke
- `tests/test_membership_cross_service_contract.py` + fixture `tests/fixtures/meeting_membership_page.json` (OpenAPI camelCase page serialization) covering auth headers, pagination (250 IDs / 3 pages), wrong token/owner, empty subject, and AI not calling public endpoints.

### Q.8 Matrix / smoke (this closure)
| Gate | Result |
|------|--------|
| AI pytest | **640 passed**, 0 failed, 23 skipped, exit **0** |
| Processing / Meeting / User Maven | **PASS** |
| QuotaConcurrencyTest required gate (`-Pquota-postgres-it` + verify script) | **tests=3 skipped=0** |
| FE lint/test/build | **PASS** |
| Contracts validate/generate/typecheck/openapi | **PASS** |
| Structural rendered K8s (`scripts/validate-rendered-k8s.py`) | **PASS** |
| Rendered component Settings (dev/staging/prod × api/worker/beat) | **PASS** |
| Membership cross-service contract | **PASS** |
| Technical fake-provider smoke | **PASS** |
| Real Gemini smoke | **NOT RUN** |
| `kubectl apply --dry-run=client` | **BLOCKED offline** (CRD discovery); structural + Settings tests substitute |

### Q.9 Remaining risks
1. Real Gemini key + staging smoke before production cutover.
2. Operators must replace sealed-secret / secret placeholders; empty `REPLACE_ME` must be rejected by production guards.
3. Offline kubectl client dry-run still needs a cluster or kubeconform in CI images that ship CRD schemas.

### Q.10 Merge gate (runtime closure)

**Ready to merge:** **Superseded by section R** — earlier gates remain necessary; Java JWT Secret wiring and Secret/SealedSecret ownership are required for cluster boot.

## R. Kubernetes Java runtime closure

### R.1 JWT secret convention
- Kubernetes Secret name: `audiomind-secrets`
- Key: `JWT_SECRET` (min 32 chars at Java startup)
- Env on meeting-api / processing-api / user-api:
  `secretKeyRef.name=audiomind-secrets`, `key=JWT_SECRET`
- Removed: Secret `jwt-secret`, key `USER_JWT_SECRET`

### R.2 Overlay secret strategy
| Overlay | Producer for `audiomind-secrets` |
|---------|----------------------------------|
| Dev | Raw `Secret` (`k8s/overlays/dev/secret.yaml`) with >=32-char JWT placeholder |
| Staging | `SealedSecret` only (`encryptedData.JWT_SECRET` + token + Gemini) |
| Prod | `SealedSecret` only |

Base no longer includes `secret.yaml` in kustomization resources (template file retained for docs only). Staging/prod do **not** patch a raw Secret alongside SealedSecret.

### R.3 Validators
- `scripts/validate-rendered-k8s.py` fails on missing Secret/SealedSecret producer or key, and on **Duplicate ownership for Secret audiomind-secrets**
- `REQUIRE_K8S_RENDER_TESTS=true` → missing kubectl/kustomize **fails** (CI); local may soft-skip
- CI job `k8s-runtime-validation` renders overlays, runs structural validator + pytest + `StartupConfigValidatorTest`

### R.4 Java startup tests
`StartupConfigValidatorTest` × meeting/processing/user: valid ≥32 PASS; empty FAIL; short FAIL.

### R.5 Matrix / smoke (this closure)
| Gate | Result |
|------|--------|
| AI pytest | **658 passed**, 23 skipped, exit **0** |
| Meeting / Processing / User Maven | **PASS** |
| QuotaConcurrencyTest required gate | **tests=3 skipped=0** |
| FE lint/test/build | **PASS** |
| Contracts | **PASS** |
| Rendered JWT wiring (meeting/processing/user × overlays) | **PASS** |
| Duplicate ownership check | **PASS** (one producer per overlay) |
| Structural validator | **PASS** |
| Java StartupConfigValidatorTest | **PASS** (3×3) |
| Technical fake-provider smoke | **PASS** |
| Real Gemini smoke | **NOT RUN** |

### R.6 Remaining risks
1. SealedSecret placeholders must be replaced with `kubeseal` ciphertext before cluster apply.
2. Real Gemini + live sealed secrets smoke on staging.
3. Offline `kubectl apply --dry-run=client` may still need API/CRD discovery; CI uses render + structural validator.

### R.7 Merge gate

**Ready to merge:** **Superseded by section S** — JWT wiring remains required; managed PostgreSQL runtime closure is now also required.

## S. Managed PostgreSQL runtime closure

### S.1 Database ownership map

Shared managed/dev PostgreSQL database name: `audiomind` (not split in this pass). Separate migration histories per owner:

| Service | Engine | Owns tables via | Env / URL format | DB owner notes |
|---------|--------|-----------------|------------------|----------------|
| meeting-api | PostgreSQL | Flyway `flyway_schema_history_meeting` | `SPRING_DATASOURCE_*` JDBC (`MEETING_DATABASE_URL`) | Meeting / study_folder / subject schemas |
| user-api | PostgreSQL | Flyway `flyway_schema_history_user` | `SPRING_DATASOURCE_*` JDBC (`USER_DATABASE_URL`) | `app_users`, quota, auth |
| processing-api | **none** | — | No datasource | Redis + HTTP clients only |
| ai-api | PostgreSQL | Alembic | `DATABASE_URL` ← `AI_DATABASE_URL` (`postgresql://…`) | AI / study generation tables |
| celery-worker | same AI DB | Alembic (shared) | same `AI_DATABASE_URL` | Executes DB-backed tasks |
| celery-beat | **none** | — | Broker only (no `DATABASE_URL`) | Schedules reconcile; workers query DB |

### S.2 Java vs Python URL convention

Secret `audiomind-db-secrets` keys:

- `MEETING_DATABASE_URL` / `USER_DATABASE_URL` → must start with `jdbc:postgresql://`
- `AI_DATABASE_URL` → must start with `postgresql://` (or `postgresql+psycopg://` / `postgresql+asyncpg://`)
- `DB_USERNAME` / `DB_PASSWORD` → shared Spring username/password

App Secret `audiomind-secrets` no longer carries database URLs.

### S.3 Overlay strategy

| Overlay | Internal DB | DB secret producer |
|---------|-------------|--------------------|
| Dev | `db-deployment` + Service `db` (dev-only resources) | Raw Secret `audiomind-db-secrets` |
| Staging | **Absent** (not scaled-to-0; not rendered) | SealedSecret template → `audiomind-db-secrets` |
| Prod | **Absent** | SealedSecret template → `audiomind-db-secrets` |

Removed from staging/prod resources: `db-secret-placeholder.yaml`, raw `db-creds`, `db-managed-patch.yaml`. Example plaintext lives in `db-secret.example.yaml` (not in `resources`).

### S.4 Wiring verification

- meeting/user/ai-api/celery-worker → `audiomind-db-secrets` keys as above
- processing → no datasource env
- beat → no `DATABASE_URL`
- staging/prod rendered manifests contain no `your-managed-db-host` / host `db` literals

### S.5 Validators & CI

- `scripts/validate-rendered-k8s.py --environment {dev,staging,prod}`: producer/key, duplicate ownership, placeholder guard, internal-DB-absent guard, JDBC vs SQLAlchemy scheme checks, beat `DATABASE_URL` ban
- Tests: `tests/test_k8s_managed_database_wiring.py`, extended `tests/test_k8s_rendered_component_settings.py`
- CI job `k8s-managed-database-validation` (required): render + structural + pytest + Spring `DatasourceContextIT` / failure tests + AI `test_database_startup.py`
- `REQUIRE_K8S_RENDER_TESTS=true` / `REQUIRE_DATASOURCE_CONTEXT_TESTS=true` fail closed when tools/Docker missing

### S.6 Context startup tests

- Meeting / User: `DatasourceContextStartupTest` (`@DataJpaTest` + Testcontainers PostgreSQL + Flyway + `StartupConfigValidator`); `DatasourceContextFailureTest` for invalid/unreachable JDBC
- AI: `test_database_startup.py` — Testcontainers PostgreSQL + AAlembic upgrade head + SQLAlchemy connect; JDBC URL rejected for SQLAlchemy
- Processing: no datasource context test (by design)

### S.7 Matrix / smoke (this closure)

| Gate | Result |
|------|--------|
| AI pytest | **689 passed**, 22 skipped, exit **0** |
| Meeting / Processing / User Maven | **PASS** |
| QuotaConcurrencyTest required gate | **tests=3 skipped=0** |
| Meeting/User datasource context + Flyway | **PASS** |
| AI SQLAlchemy + Alembic startup | **PASS** |
| FE lint/test/build | **PASS** |
| Contracts | **PASS** |
| Managed DB render/validator | **PASS** (dev/staging/prod) |
| Technical fake-provider smoke | **PASS** (prior Phase 2 gates retained) |
| Real Gemini smoke | **NOT RUN** |
| Managed database smoke (render + wiring) | **PASS** |
| `kubectl apply --dry-run=client` | **BLOCKED offline** (API server unreachable); structural validator substitutes |

### S.8 Remaining risks

1. Staging/prod SealedSecret still uses `REPLACE_WITH_SEALED_*` markers until real `kubeseal` ciphertext is applied — **template committed, cluster-ready secret not yet present**.
2. Shared DB `audiomind` remains; future per-service databases would require new keys and migrations.
3. Offline `kubectl apply --dry-run=client` may still hit CRD discovery limits; structural validator covers Secret references.

### S.9 Merge gate

**Ready to merge:** **Yes** — meeting/user/AI/worker staging/prod use managed `audiomind-db-secrets` (not host `db`); processing has no fake datasource; beat has no `DATABASE_URL`; internal DB is dev-only; no raw placeholder DB Secret in staging/prod; JDBC vs SQLAlchemy schemes enforced; Spring + AI context startup tests pass; managed-DB CI gate required; prior Phase 2 gates green; tracked tree clean after commits.

## T. Staging deployment readiness closure

### T.1 Three readiness states (do not collapse)

| State | Meaning |
|-------|---------|
| **Ready to merge** | Code/tests/CI merge gates green; overlays render; validators pass in code-only mode |
| **Ready to deploy staging** | Real SealedSecret ciphertext, managed PostgreSQL TLS URLs, ordered migrations, rollout, health, managed-DB + Phase 2 smokes |
| **Ready for production cutover** | Staging deploy ready + real Gemini smoke + observation window + DB backup + rollback procedure + prod SealedSecrets |

### T.2 AI database driver / scheme

- Runtime installs **psycopg2-binary** only.
- Allowed: postgresql://, postgresql+psycopg2://.
- Rejected: jdbc:postgresql://, postgresql+psycopg://, postgresql+asyncpg://.
- Staging/prod production Settings require sslmode=require or sslmode=verify-full.

### T.3 Migration dependency and ordering

- Meeting Flyway **V15** hard-depends on public.app_users (user-service V1).
- Method A: Jobs user-db-migrate → meeting-db-migrate → ai-db-migrate applied **sequentially** by scripts/deploy-staging.* with kubectl wait --for=condition=complete.
- Java migration profile: SPRING_PROFILES_ACTIVE=migration + MigrationShutdownRunner + pplication-migration.yml (web-application-type: none).
- AI: Alembic upgrade head in ai-db-migrate Job.
- Fallback: meeting-api (and meeting migrate Job) wait-user-schema initContainer logs WAITING_FOR_USER_SCHEMA / USER_SCHEMA_READY / USER_SCHEMA_WAIT_TIMEOUT.

### T.4 SealedSecret workflow

- Active staging/prod kustomization **does not** include placeholder SealedSecrets.
- Templates: sealed-secret.example.yaml, sealed-db-secret.example.yaml (outside resources).
- Generate real ciphertext: scripts/generate-sealed-secrets.sh / .ps1 (requires kubeseal + cert).
- Output: sealed-secret.generated.yaml / sealed-db-secret.generated.yaml (gitignored; apply out-of-band).
- **No fake ciphertext** is checked in.

### T.5 Placeholder / PVC / TLS / probes

- alidate-rendered-k8s.py: staging/prod forbid REPLACE_WITH_SEALED etc.; --deploy-ready requires real ciphertext; auto --code-only for merge CI.
- postgres-data-pvc moved to **dev-only** (k8s/overlays/dev/postgres-pvc.yaml).
- API deployments: readiness + liveness + startup probes.
- Staging/prod rolling update: maxUnavailable: 0, maxSurge: 1, progress/revision/grace limits.

### T.6 Beat no-database startup

- Beat skips DB Settings validation; database.py lazy engine refuses APP_COMPONENT=beat.
- Subprocess coverage: 	ests/test_beat_subprocess_startup.py.

### T.7 Deploy scripts and smokes

- scripts/deploy-staging.sh / .ps1: ordered migrate → rollout → health → optional smokes.
- scripts/smoke-managed-db.py, smoke-phase2-staging.py, smoke-real-gemini.py (RUN_REAL_GEMINI_SMOKE).

### T.8 Honest status (this closure)

| Gate | Status |
|------|--------|
| Ready to merge | **YES** (when full matrix green on this branch) |
| Ready to deploy staging | **NO** until real SealedSecret ciphertext + managed DB credentials + cluster apply/smoke succeed |
| Ready for production cutover | **NO** (requires Gemini smoke + observation + backup + prod seals) |

Remaining operator actions: run generate-sealed-secrets against cluster cert; point URLs at managed Postgres with TLS; execute deploy-staging; run managed-DB + Phase 2 smokes; optionally RUN_REAL_GEMINI_SMOKE=true.

## U. Full-stack staging deployment closure

### U.1 Three readiness states

| State | Meaning |
|-------|---------|
| Ready to merge | Code/tests/CI merge gates green |
| Ready to deploy staging | Real seals + managed DB + ordered migrate + rollouts + managed-DB smoke + Phase 2 E2E smoke |
| Ready for production cutover | Staging deploy ready + real Gemini smoke + observation + backup + prod seals |

### U.2 FE implementation status

- Phase 2 UI: SubjectDetail, Synthesis, Mind map (evidence click), Flashcards/MCQ/Essay evidence, Exam brief (no per-item evidence in schema), regenerate, polling abort on unmount, per-artifact status, **delete artifact** with ConfirmDialog.
- Exam brief: no per-item segment evidence in contract — intentionally not faked.

### U.3 FE Kubernetes deployment

- rontend-deployment + Service rontend wired into dev/staging/prod.
- Ingress: API prefixes first, / → frontend last; unified host pp.audiomind.example.com.
- Vite build-args use relative /api/* for staging CI web image.

### U.4 CI/CD deployment path

- .github/workflows/ci-cd.yaml deploy-staging **calls scripts/deploy-staging.sh only** (no direct full-overlay apply before migrations).
- Image SHA overrides for user/meeting/processing/ai/frontend/worker/beat + migrate jobs.
- Merge CI: bash LF/shellcheck, kubeconform+checksum, FE build, contracts, migration-order, staging --deploy-ready fail-closed.

### U.5 Namespace / images / STT / diarization / secrets

- Staging namespace: udiomind-staging; prod: udiomind.
- STT Method B: staging/prod STT_PROVIDER=local_whisper + ALLOW_LEGACY_LOCAL_STT=true; Deepgram key optional.
- Diarization: staging/prod ENABLE_SPEAKER_DIARIZATION=false until HF token provisioned.
- Generator seals JWT/INTERNAL/GEMINI/HF/GF_* (+ DEEPGRAM when STT=deepgram). No fake ciphertext in-repo.

### U.6 Migration / worker / beat / probes

- Ordered Jobs user→meeting→AI; delete-before-apply; image inject; logs on failure.
- Worker/Beat share AI image SHA; Beat no DATABASE_URL; Beat probe kill -0 1.
- Java APIs: /actuator/health/liveness|readiness; AI /health|/ready; FE /.

### U.7 Smokes / kubeconform / matrix notes

- Phase 2 smoke fail-closed without fixture/creds; requires 5 COMPLETED artifacts + quota idempotency.
- Managed DB smoke gated by RUN_MANAGED_DB_SMOKE.
- Deploy verdict never claims Ready to deploy staging when smokes skipped.
- Linux migration test uses shared Docker network (no host.docker.internal).

### U.8 Honest status

| Gate | Status |
|------|--------|
| Ready to merge | YES when full matrix green |
| Ready to deploy staging | NO until cluster seals + DB + smokes |
| Ready for production cutover | NO |

Remaining operator actions: generate real SealedSecrets; configure KUBE_CONFIG + managed DB URLs; run deploy-staging with smokes; observe staging; Gemini smoke + backup before cutover.

## V. VPS Docker Compose deployment closure

### V.1 Scope

Single-domain VPS path (Docker Compose + host Nginx + Certbot). Does not replace the Kubernetes staging/production overlays documented in sections T–U.

### V.2 Deliverables

| Artifact | Purpose |
|----------|---------|
| .env.production.example (repo root) | Single-domain env template with __SAME_ORIGIN__ FE build sentinels |
| infra/.env.production.example | Header points to root template; legacy multi-domain vars retained |
| infra/docker-compose.vps.yml | VPS compose stack (postgres, redis, APIs, Celery, frontend, migrate jobs) |
| scripts/deploy-vps.sh | Build → DB → migrate → up stack → loopback health → smoke |
| scripts/vps-migrate.sh / .ps1 | Ordered Flyway bootstrap + user/meeting/AI migrations |
| scripts/smoke-vps.sh | Infra + application loopback readiness |
| scripts/backup-vps.sh | pg_dump via compose exec → `backups/*.sql.gz` |
| infra/nginx/audiomind-vps.conf.example | Same-origin path routing (resolves /api/config/upload vs /api/config/lexicon) |
| docs/vps-deployment.md | Operator runbook (Docker, DNS, deploy, TLS, UFW, backup, rollback) |
| FE `config.ts` / `auth.ts` | __SAME_ORIGIN__ → empty base URL for relative /api/* calls |

### V.3 Migration order

1. db-flyway-bootstrap (when defined)
2. user-db-migrate (or user-api Spring migration profile one-shot)
3. meeting-db-migrate (or meeting-api migration profile)
4. ai-db-migrate (Alembic)

Forward-only; rollback = restore `backups/*.sql.gz`, not down migrations.

### V.4 Nginx routing notes

- =/api/config/upload → meeting-api (upload policy)
- /api/config/lexicon → ai-api (domain lexicon)
- /api/config/transcript-quality → processing-api
- /ws/meetings → processing-api with WebSocket upgrade headers
- Broader /api/ → ai-api after more specific prefixes

### V.5 Honest status

| Gate | Status |
|------|--------|
| Code complete | **YES** — compose, scripts, env template, Nginx example, FE `__SAME_ORIGIN__`, docs |
| Compose validated | **YES** — `docker compose --env-file .env.production.example -f infra/docker-compose.vps.yml --profile migrate config` passes; CI job `vps-compose-validation` added |
| Local container smoke | **NOT RUN in this closure** — requires `./scripts/deploy-vps.sh` on a Docker host with a real filled `.env.production` |
| Real VPS | **NO** — requires DNS + host Nginx + Certbot + filled secrets on the VPS |

STT for VPS: `STT_PROVIDER=deepgram` with `INSTALL_OFFLINE_STT=false` (no torch/Whisper). Diarization default `false`.

Phase 2 functional smoke (login → subjects → synthesis) is **NOT RUN** without `SMOKE_JWT` / real fixtures.

Remaining operator actions: create/fill `.env.production`, run `./scripts/deploy-vps.sh`, install Nginx example + Certbot, schedule `./scripts/backup-vps.sh`, optionally `SMOKE_JWT=... ./scripts/smoke-vps.sh`.
