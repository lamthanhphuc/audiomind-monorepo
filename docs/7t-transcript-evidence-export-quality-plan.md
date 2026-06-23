---
title: "7T — Transcript, Evidence & Export Quality — Implementation Plan"
status: DRAFT
updated: 2026-06-22
revision: 13
implementation_ready: true
branch: feat/transcript-evidence-export-quality
---

**Implementation-ready (rev 13):** Spec §14 file map + hook placement §5.3. Bắt đầu Slice 1 ngay sau merge doc.

## Overview

Plan chia Epic 3 theo **7 TDD slices** (test → implement → refactor). Mỗi slice có feature flag (trừ Slice 1 và 7), default **`false`** để đảm bảo no regression.

**Branch:** `feat/transcript-evidence-export-quality`

**Primary code areas:**

| Area | Key paths |
|------|-----------|
| Transcript FE | `FE-Audiomind/src/utils/transcript.ts`, `TranscriptDisplay.tsx`, `AnalysisStatusPanel.tsx`, `MeetingHistoryScene.tsx` |
| Transcript/Search/Export BE | `processing-service/.../ProcessingService.java`, `TranscriptEvidenceSearchService.java`, `service/report/*` |
| Canonical/Glossary AI | `ai-service/app/services/transcript_canonicalizer.py`, `glossary_service.py`, `keyword_matcher.py` |
| Contracts | `packages/contracts/transcript-quality-policy.json`, `default-policy.json`, `processing-api.yaml` |

**Naming note:** Không tạo `EvidenceService` / `ExportService` / `SearchService` — mở rộng class hiện có để tránh refactor rộng.

---

## Task Breakdown (TDD slices)

### Slice 1 — Baseline audit + contract inventory

- **Goal:** Artifact source-of-truth + baseline inventory; liệt kê gap OpenAPI.
- **Deliverables:**
  - `packages/contracts/transcript-quality-policy.json`
  - `packages/contracts/default-policy.json` — fallback source of truth (§5.2)
  - Schema validation for **both** files in `packages/contracts/config.schema.json` (or dedicated schema)
  - `scripts/sync-default-policy.sh` — copy `default-policy.json` → `FE-Audiomind/src/config/transcriptQualityDefaults.json`; **khuyến nghị** cũng generate `FE-Audiomind/src/config/fallback-policy.ts` (`FALLBACK_POLICY` constant)
  - `FE-Audiomind/src/config/fallback-policy.ts` — hardcoded fallback đồng bộ với `default-policy.json`; CI drift check `fallback-policy.ts` ↔ `default-policy.json`
  - **CI:** chạy `sync-default-policy.sh` **trước** FE tests để bundle + fallback constant luôn đồng bộ
  - Cập nhật `FE-Audiomind/package.json`: gọi sync script trong `prebuild` hoặc `prepare`
  - `packages/tooling/config-validation/` — CI asserts policy/default sync; validate JSONB `segment_id`, `term_frequency` + `evidence_stats.idf` (§9.1.2)
  - `docs/epic3-baseline-inventory.md` — bảng file/symbol (transcript, evidence, export, search, lexicon):
    - Symbols cần modify/refactor (class, method, DTO)
    - Endpoint drift (FE `getTranscript` legacy path vs OpenAPI)
    - TODO items: realtime `MeetingWebSocketHandler.finalizeSttSession()` hook (§5.3), FE `getTranscript` path migration
- **Work:**
  - Audit grep + Fullerenes: confirm symbols in §2 spec
  - **`ConfigController`** + **`Epic3PolicyLoader`** + **`SecurityConfig`**: `requestMatchers(HttpMethod.GET, "/api/config/transcript-quality").permitAll()` (§5.2)
  - Document OpenAPI gaps: missing `/transcript/search`, `/action-plan`, `/action-plan/export`
  - Document FE path drift: `getTranscript` uses `/processing/transcript/{meetingId}` vs REST `/{meetingId}/transcript`
  - **Subtask:** FE migrate `getTranscript` from legacy path to canonical path — hoặc ghi technical debt rõ trong inventory nếu defer
- **Feature flag:** none
- **Rollback:** N/A (artifact only)
- **Tests:**
  - `validate-schemas.mjs` includes policy + `default-policy.json`
  - CI: `transcriptQualityDefaults.json` + `fallback-policy.ts` exist; schema/drift vs `default-policy.json`
  - snapshot both JSON files; drift check policy vs default
- **Commit:** `feat(contracts): add transcript quality policy contract (#Epic3)`

### Slice 2 — Transcript quality improvements

- **Goal:** HTTP → Celery persist (`termFrequency` + `evidence_stats`); version read log-only; backfill `--rebuild-stats`.
- **Subtasks:**
  - **(a) ai-service HTTP + Celery (1d):**
    - `POST /api/internal/meetings/{meetingId}/canonicalize` → **202** `{ "taskId": "..." }` (§5.3.1)
    - `GET /api/internal/meetings/{meetingId}/transcript-quality` → DTO §5.3.2 (camelCase HTTP; JSONB snake_case persist)
    - Handler enqueue `app.tasks.canonicalize_and_persist` (≠ `process_meeting`)
    - **`runId` resolution:** realtime `finalizeSttSession()` sends `runId=null` → latest run **any status** `ORDER BY updated_at DESC LIMIT 1`; if none → `app.tasks.canonicalize_deferred_retry` 5s × max 5 or log `TRANSCRIPT_QUALITY_SKIP_NO_RUN`
    - **Hash:** reuse `build_canonical_transcript_hash()` in `transcript_canonicalizer.py` — `SHA256(json.dumps(canonical_rows, ...) + canonicalTranscriptVersion)`; excludes `segment_id`/`term_frequency`
    - **Idempotency:** pre-enqueue sync canonicalize preview vs DB hash; Redis `canonicalize:{meetingId}:{runIdOrNone}:{hash}` (`runIdOrNone` = id hoặc `none`) TTL 10m — exists → skip (`reason=in_flight`); else SET + enqueue; persisted hash → `reason=persisted`; log `TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP`, still 202
    - `autoretry_for=(Exception,)`, `retry_backoff=60`, `max_retries=3`
    - Trong task, sau `canonicalize_segments`:
      1. Gán `segment_id` (UUID) per row (JSONB snake_case)
      2. Tokenize segment text với **shared tokenizer** (regex `\b\w+\b` + §2.4 normalization) → `term_frequency` per segment (raw count)
      3. Tính `idf` map (ln) cho toàn meeting → `evidence_stats` (snake_case: `segment_count`, `computed_at`, `canonical_version`)
      4. Persist `canonical_transcript_rows` + `evidence_stats` + `canonical_transcript_version` + `canonical_transcript_hash`
    - Shared utility: `tokenize_for_tf_idf(text)` — Python + Java ports; **unit test riêng** với golden vectors
    - Metric `canonical_persist_duration_ms`; Celery-down fallback: `asyncio.create_task`
    - Wire trigger points §5.3 — exact lines in spec §5.3 hook table (`MeetingWebSocketHandler` ~L1280/L1203; `ProcessingService.processMeeting` ~L327)
  - **(b) processing-service client (0.5d):**
    - Gọi HTTP canonicalize sau terminal (`POST /api/internal/.../canonicalize`)
    - **`AIServiceClient`:** snake_case JSONB ↔ camelCase DTO mapping
    - `selectReadableTranscriptSource()` calls `GET /api/internal/.../transcript-quality` when flag on; `ready` = rows + stats + hash non-null
    - **TranscriptQualityContext mapping layer:** DTO → pre-stabilization canonical rows + `evidenceStats` (§5.3.2)
    - Implement §5.3.3 stabilized → canonical mapping (segmentId first, 50% overlap fallback)
    - **`mergeStableSpeakerSegments`:** keep first segment's `segmentId`; log `TRANSCRIPT_QUALITY_MERGE_NO_SEGMENT_ID` if missing
    - `ready=false` → log `TRANSCRIPT_QUALITY_NOT_READY`; version mismatch → `TRANSCRIPT_QUALITY_VERSION_MISMATCH`; raw fallback only
  - **(c) FE merge align (0.5d):** runtime policy via `getTranscriptQualityPolicy()` (§5.2); legacy `getTranscript` path noted in Slice 1
  - **(d) migration (0.25d):** `canonical_transcript_rows` + `evidence_stats` JSONB only (§9.1); `canonical_transcript_hash` **already in 006** — verify index, không ADD COLUMN
  - **(e) backfill (0.25d):** `backfill_canonical.py` + `scripts/backfill-canonical.py` — generate `segment_id` if missing; `--rebuild-stats` default on; `--batch-size` 100; `--concurrency` 1; log `BACKFILL_PROGRESS` (per-worker + `workerId` when concurrency > 1)
  - **Ví dụ lệnh:**
    ```bash
    scripts/backfill-canonical.py --meeting-id 123 --rebuild-stats --dry-run
    scripts/backfill-canonical.py --batch-size 100 --concurrency 2 --dry-run
    ```
- **Feature flag:** `TRANSCRIPT_QUALITY_ENABLED`
- **Tests:** HTTP 202; GET transcript-quality DTO + `ready` semantics; Redis in-flight idempotent skip (`reason=in_flight`); `TRANSCRIPT_QUALITY_SKIP_NO_RUN`; no Java→Celery; mismatch log-only; backfill `--dry-run` validates `segment_id` + `term_frequency` + `evidence_stats.idf`; perf P95 < 200ms @ 1000 segments
- **Commit:** `feat(transcript): internal canonicalize endpoint and version-aware read (#Epic3)`

### Slice 3 — Domain lexicon integration

- **Goal:** Domain packs; collision logging; FE per-meeting fetch.
- **Work:**
  - Domain packs schema §5.5 (`packages/contracts/domain-packs/*.json`) + `disabledTerms` in policy
  - **`GET /api/config/lexicon?domain={domain}` on ai-service** (not processing-service)
  - **FE:** fetch ``${AI_INTERNAL_BASE}/api/config/lexicon?domain={domain}`` — distinct from `PROCESSING_API_BASE` transcript-quality config; public read / CORS note (§5.5)
  - Merge: pack > DB > FE static; log `DOMAIN_LEXICON_COLLISION` on key collision (pack wins)
  - **FE:** `domainMode` = `meeting.metadata.domainMode` → fetch pack; cache `domainPack-{domain}-{versionHash}`
  - ai-service: `glossary_service.resolve()` union merge
  - Realtime: `keyword_matcher` same term set when flag on
- **Feature flag:** `DOMAIN_LEXICON_ENABLED`
- **Rollback:** flag off → FE `itTerms.ts` only; glossary DB baseline unchanged
- **Tests:**
  - `test_glossary_wiring.py` with domain pack fixture
  - FE: highlight renders pack term
  - Config endpoint returns pack version hash
- **Commit:** `feat(lexicon): domain pack integration (#Epic3)`

### Slice 4 — Evidence QA (verification + deduplication)

- **Goal:** Canonical score formula; evidence in analysis JSON; FE verified block.
- **Subtasks:**
  - **(a) scoring/dedupe (1d):**
    - Map stabilized segment → canonical row (§5.3.3) via `TranscriptQualityContext` before `termFrequency` / `position_norm` lookup
    - Read `evidence_stats.idf[term]` + `canonicalRow.termFrequency[term]`
    - `score = idf × tf × (1 - position_norm × positionNormDecay) × speaker_boost` — ln-IDF, raw tf; clamp then `verificationStatus`
    - `dedupeKey` = `SPEAKER_{speakerLabel}:{startTime}:{endTime}:{textHash}`; window = same speaker + startTime diff ≤ `dedupeWindowSeconds`
    - **No runtime IDF**
  - **Fallback:** `evidence_stats` NULL hoặc `idf` missing → `idf=0.0`, score=0, `unverified`; log `EVIDENCE_QA_STATS_MISSING` — unit test cả 2 cases
  - **(b) FE verified preview (0.5d):** render from `analysis.evidence.matches`
  - **(c) golden fixture (0.25d):** `5-segment-golden.json` + Java/Python parity tests (Appendix A §5.4)
- **Work:**
  - Shared score unit tests (Java) with golden vectors
  - Log `EVIDENCE_QA_VERIFIED` / `EVIDENCE_QA_WEAK` / `TRANSCRIPT_QUALITY_SEGMENT_MAP_MISSING`
- **Feature flag:** `EVIDENCE_QA_ENABLED`
- **Rollback:** flag off → current top-1 search match behavior
- **Tests:**
  - Java: adjacent duplicate segments → single evidence
  - Java: score below threshold → `unverifiedEvidenceNote`
  - FE: action plan preview shows verified badge
- **Commit:** `feat(evidence): qa scoring and deduplication (#Epic3)`

### Slice 5 — Search verification

- **Goal:** Harden search + performance fallback; preserve legacy ranking when only `EVIDENCE_QA` on (§5.4 dual-mode).
- **Work:**
  - Policy: `maxScanSegments`, `scanPreference` (`recent` | `all`)
  - **`SEARCH_VERIFY_ENABLED` stricter guards** (§5.7): policy `minQueryLength` reject, `minTokenLength` skip, `maxLimit` replaces hardcoded 50
  - **`EVIDENCE_QA` on + `SEARCH_VERIFY` off:** search keeps phrase > token > position ranking; `TranscriptEvidenceMatch` may include `score` for FE — order unchanged
  - Diacritic normalization + **shared tokenizer** §2.4 — refactor search path to `TokenizerUtil` (Java)
  - Golden fixtures; OpenAPI search schema
  - `scanPreference=recent`: tail `maxScanSegments`; log `SEARCH_QUERY_LIMITED` with `scanPreference`
  - `SEARCH_VERIFY_ENABLED`: stricter guards (unchanged API shape)
- **Tests:**
  - >2000 segments fixture → limited scan + marker
  - Perf: P95 < 100ms @ 500 segments — O(1) `idf`/`termFrequency` lookup (§5.4, §10.3)
- **Feature flag:** `SEARCH_VERIFY_ENABLED`
- **Rollback:** flag off → existing search ranking (cap still applies when configured in policy)
- **Commit:** `feat(search): transcript evidence search verification (#Epic3)`

### Slice 6 — Export verification & cleanup

- **Goal:** Golden exports + generation script; preflight verify.
- **Subtasks:**
  - **(a) fixtures + script (0.5d):**
    - Add `src/test/resources/fixtures/meeting-golden.json`
    - `scripts/generate-export-goldens.sh` — reads `meeting-golden.json` by default; writes `export-golden/`
  - **(b) preflight verify (0.5d):** `EXPORT_VERIFY_ENABLED`; log `EXPORT_VERIFY_COMPLETED` (all §7.1 fields)
- **Tests:** byte-to-byte goldens; DOCX export P95 < 500ms
- **Feature flag:** `EXPORT_VERIFY_ENABLED`
- **Rollback:** flag off → skip preflight verify
- **Commit:** `feat(export): verification and openapi alignment (#Epic3)`

### Slice 7 — Observability + smoke scripts

- **Goal:** Operability cho Epic 3; **implement every mandatory log field in spec §7.1**.
- **Work:**
  - `scripts/log-bundle.sh`: `EPIC3_PATTERN` includes `EVIDENCE_QA_*`, `BACKFILL_PROGRESS`
  - `scripts/test_log_bundle_epic3.sh` — assert **all** §7.1 markers including `EVIDENCE_QA_STATS_MISSING`
  - Wire alerts spec §8
  - Metric: `canonical_persist_duration_ms`
  - `docs/deploy/production-smoke-checklist.md` — Epic 3 section

**§7.1 implementation checklist (Slice 7 — must not omit fields):**

| Marker | Required fields |
|--------|-----------------|
| `TRANSCRIPT_QUALITY_CANONICAL_PERSISTED` | `meetingId`, `rowsBefore`, `rowsAfter`, `durationMs`, `version` |
| `TRANSCRIPT_QUALITY_PERSIST_FAILED` | `meetingId`, `errorCode`, `durationMs` |
| `TRANSCRIPT_QUALITY_VERSION_MISMATCH` | `meetingId`, `storedVersion`, `expectedVersion` |
| `TRANSCRIPT_QUALITY_NOT_READY` | `meetingId`, `reason` |
| `TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP` | `meetingId`, `runId`, `canonicalTranscriptHash`, **`reason`** (`persisted` \| `in_flight`) |
| `TRANSCRIPT_QUALITY_SKIP_NO_RUN` | `meetingId`, `attemptCount` |
| `TRANSCRIPT_QUALITY_MERGE_NO_SEGMENT_ID` | `meetingId`, `mergedStart`, `mergedEnd`, `speaker` |
| `TRANSCRIPT_QUALITY_SEGMENT_MAP_MISSING` | `meetingId`, `stabilizedStart`, `stabilizedEnd`, `speaker` |
| `TRANSCRIPT_QUALITY_ASYNC_FALLBACK` | `meetingId`, `reason` |
| `TRANSCRIPT_QUALITY_FALLBACK_RAW` | `meetingId`, `sourceReason`, `flagEnabled` |
| `POLICY_LOAD_FALLBACK` | `path`, `reason`, `service` |
| `DOMAIN_LEXICON_LOADED` | `domain`, `versionHash`, `termCount` |
| `DOMAIN_LEXICON_COLLISION` | `term`, `packSource`, `dbSource`, `domain` |
| `DOMAIN_LEXICON_FALLBACK_STATIC` | `domain`, `reason` |
| `EVIDENCE_QA_VERIFIED` | `meetingId`, `matchCount`, `avgScore`, `minScore` |
| `EVIDENCE_QA_WEAK` | `meetingId`, `matchCount`, `avgScore` |
| `EVIDENCE_QA_DEDUPED` | `meetingId`, `removedCount`, `dedupeWindowSeconds` |
| `EVIDENCE_QA_STATS_MISSING` | `meetingId`, `term`, `reason` |
| `TRANSCRIPT_SEARCH_REQUEST` | `meetingId`, `queryHashPrefix`, `resultCount` |
| `TRANSCRIPT_SEARCH_REJECTED` | `meetingId`, `reason`, `queryLength` |
| `SEARCH_QUERY_LIMITED` | `meetingId`, `totalSegments`, `scannedSegments`, `queryHashPrefix`, `scanPreference` |
| `EXPORT_VERIFY_STARTED` | `meetingId`, `format`, `mode` |
| `EXPORT_VERIFY_FAILED` | `meetingId`, `format`, `mode`, `errorCode` |
| `EXPORT_VERIFY_COMPLETED` | `meetingId`, `format`, `mode`, `byteLength`, `rowCount` |
| `BACKFILL_PROGRESS` | `processedCount`, `successCount`, `failureCount`, `batchSize` (`workerId` optional) |

- **Feature flag:** none
- **Tests:** smoke script validates field presence for each marker type
- **Commit:** `feat(observability): epic 3 log markers and smoke checklist (#Epic3)`

### Slice E2E — Integration test end-to-end

- **Goal:** Full user journey regression after export slice.
- **When:** Chạy **sau Slice 6**, trước hoặc song song Slice 7.
- **Location:** `demoRecordAUDIOMID/processing-service/src/test/java/com/example/processingservice/integration/Epic3EndToEndIT.java`
- **Profile:** `@ActiveProfiles("epic3-e2e")` — `application-epic3-e2e.yml` enables Epic 3 flags for test only
- **Flow:**
  1. Seed/load from `fixtures/meeting-golden.json` or upload audio fixture
  2. `@MockBean` ai-service HTTP: canonicalize → **202**; seed JSONB (`canonical_transcript_rows`, `evidence_stats`) for processing-service tests
  3. Wait transcript finalize + mocked `canonicalize_and_persist` side effects (or test Celery worker)
  4. `GET /transcript/search?q={keyword}` — assert match
  5. `GET /action-plan` — assert `evidence.matches[].verificationStatus=verified`
  6. `GET /action-plan/export?format=docx` — assert content vs golden or key strings
- **Separate job:** all flags off → baseline snapshots unchanged
- **Commit:** `test(epic3): end-to-end transcript search evidence export (#Epic3)`

---

## Feature Flags

| Flag | Slice | Default | Staging rollout | Disable effect |
|------|-------|---------|-----------------|----------------|
| `TRANSCRIPT_QUALITY_ENABLED` | 2 | `false` | on after slice 2 tests | skip hot-path canonical; FE legacy merge |
| `DOMAIN_LEXICON_ENABLED` | 3 | `false` | on for `it` pack first | FE static itTerms; DB glossary only |
| `EVIDENCE_QA_ENABLED` | 4 | `false` | on after search stable | top-1 match without score gate |
| `SEARCH_VERIFY_ENABLED` | 5 | `false` | on in staging | legacy ranking |
| `EXPORT_VERIFY_ENABLED` | 6 | `false` | on before prod export QA | skip export preflight verify |

**Config wiring (proposed):**

```java
// processing-service — mirror Epic2FeatureFlags
@ConfigurationProperties(prefix = "epic3")
public class Epic3FeatureFlags {
    private boolean transcriptQualityEnabled = false;
    private boolean domainLexiconEnabled = false;
    private boolean evidenceQaEnabled = false;
    private boolean searchVerifyEnabled = false;
    private boolean exportVerifyEnabled = false;
    // getters/setters
}
```

```yaml
# processing-service application.yml
epic3:
  transcript-quality-enabled: ${TRANSCRIPT_QUALITY_ENABLED:false}
  domain-lexicon-enabled: ${DOMAIN_LEXICON_ENABLED:false}
  evidence-qa-enabled: ${EVIDENCE_QA_ENABLED:false}
  search-verify-enabled: ${SEARCH_VERIFY_ENABLED:false}
  export-verify-enabled: ${EXPORT_VERIFY_ENABLED:false}
```

```python
# ai-service config.py — chỉ 2 flags cần trên ai-service
transcript_quality_enabled: bool = False
domain_lexicon_enabled: bool = False
```

**ai-service flag scope:** Chỉ `TRANSCRIPT_QUALITY_ENABLED` (canonicalize Celery, persist) và `DOMAIN_LEXICON_ENABLED` (glossary packs, lexicon endpoint). Các flags `EVIDENCE_QA_ENABLED`, `SEARCH_VERIFY_ENABLED`, `EXPORT_VERIFY_ENABLED` **chỉ** trên **processing-service** (scoring, search guards, export preflight).

```python
# ai-service app/tasks.py — distinct from process_meeting
@celery_app.task(
    name="app.tasks.canonicalize_and_persist",
    autoretry_for=(Exception,),
    retry_backoff=60,
    max_retries=3,
)
def canonicalize_and_persist(meeting_id: int, run_id: int) -> None: ...
```

```env
# infra/.env.example (append)
TRANSCRIPT_QUALITY_ENABLED=false
DOMAIN_LEXICON_ENABLED=false
EVIDENCE_QA_ENABLED=false
SEARCH_VERIFY_ENABLED=false
EXPORT_VERIFY_ENABLED=false
```

**Policy fallback:** Load at startup → `POLICY_LOAD_FALLBACK` on failure → hardcoded defaults.

**Policy reload (MVP):** **Policy changes require service restart.** Document in deploy runbook.

**TODO (post-MVP):** Spring Cloud Config + `/actuator/refresh` for processing-service; optional hot-reload for ai-service policy file.

---

## Dependencies

### Services

- `processing-service` (search, export, transcript read path, action plan)
- `ai-service` (canonical persist, glossary, keyword matcher)
- `meeting-service` (auth/ownership boundary — unchanged)
- `FE-Audiomind` (display, search UI, export buttons, highlight)

### Libraries (existing)

- Apache POI (DOCX) — already in processing-service
- Python transcript canonicalizer — in-repo
- **Celery 5.4** + Redis broker — already in ai-service (`app/celery_app.py`, `app/tasks.py`)
- No new search DB dependency for MVP

### Slice dependency graph

```text
Slice 1 (contract)
  → Slice 2 (transcript quality) — includes migration + backfill script
  → Slice 3 (lexicon) — optional parallel after Slice 1
  → Slice 4 (evidence QA) — depends on Slice 2 readable source stable
  → Slice 5 (search verify) — depends on Slice 2; benefits Slice 4
  → Slice 6 (export verify) — depends on Slice 2 + 4
  → Slice E2E — after Slice 6
  → Slice 7 (observability) — after Slice 2–6 markers exist
```

---

## Data Migration (implementation checklist)

| Step | Owner | Notes |
|------|-------|-------|
| Alembic `canonical_transcript_rows` + `evidence_stats` JSONB | ai-service | Nullable; no auto-backfill; hash column from 006 |
| Populate `term_frequency` + `idf` on persist/backfill | ai-service | Required for Slice 4 |
| Extend `backfill_canonical.py` | ai-service | `--rebuild-stats` default **on** |
| Ops `scripts/backfill-canonical.py` | scripts | `--dry-run` pre-prod gate (§12) |
| `fixtures/meeting-golden.json` | processing-service | Slice 6 input for goldens |
| Repair script | ai-service | Same as backfill — must include `--rebuild-stats` |
| Verify indexes §9.1.1 | ai-service | No GIN on JSONB (MVP) |
| `scripts/generate-export-goldens.sh` | scripts | Slice 6 — golden regeneration |
| Legacy `transcripts.canonical_transcript_rows` | — | Keep for compat |

---

## Monitoring & Alerts (staging/prod)

Wire alerts per spec §8:

| Alert | Threshold | Window |
|-------|-----------|--------|
| `Epic3CanonicalPersistFailureHigh` | failure rate > 5% | 10 min |
| `Epic3CanonicalPersistFailedCount` | `TRANSCRIPT_QUALITY_PERSIST_FAILED` > 10 | 15 min |
| `Epic3EvidenceWeakRatioHigh` | weak ratio > 50% | 30 min |
| `Epic3ExportFailureHigh` | failure rate > 2% | 15 min |
| `Epic3LexiconCollisionHigh` | `DOMAIN_LEXICON_COLLISION` > 100 | 1 hour (P3) |

Metrics: `canonical_persist_duration_ms` histogram on Celery workers.

Slice 7: dashboard panels + runbook in `production-smoke-checklist.md`.

---

## Performance Testing (staging gate)

| Test | Threshold | When |
|------|-----------|------|
| Canonical persist (Celery) | P95 < 200ms @ 1000 segments | Before `TRANSCRIPT_QUALITY_ENABLED` prod |
| Search | P95 < 100ms @ 500 segments | O(1) `idf` + `termFrequency` lookup; viable to ~10k segments (§5.4) |
| DOCX export | P95 < 500ms | Before `EXPORT_VERIFY_ENABLED` prod |

Nightly CI profile recommended; not blocking PR in MVP.

---

## OpenAPI Update Plan (Slice 1 + 5 + 6)

See spec §11. Implementation order:

1. **Slice 1:** inventory gaps; mark `GET /processing/transcript/{meetingId}` as **`deprecated: true`** → point to `GET /processing/{meetingId}/transcript`
2. **Slice 5:** add/update `GET /{meetingId}/transcript/search` + `TranscriptSearchResponse`
3. **Slice 6:** add `action-plan`, `action-plan/export`, document `transcript/export` params
4. **Slice 3:** add `GET /api/config/lexicon` on **ai-service** (`ai-api.yaml` or service README)
5. **Slice 1/2:** add `GET /api/config/transcript-quality` on **processing-service**
6. **Slice 4:** add `EvidenceBlock` + `evidence` on `ActionPlanResponse`; `TranscriptEvidenceMatch` optional fields + `x-epic3: true`
7. **Slice 2:** document `GET/POST /api/internal/meetings/...` in ai-service README (not public OpenAPI)

CI contract-check must pass after each OpenAPI edit.

---

## Risk & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Canonical hot-path slows finalize | Latency on meeting complete | **Celery async** — finalize non-blocking; monitor `canonical_persist_duration_ms` |
| Large transcript O(n) search slow | Timeouts | `maxScanSegments=2000` + `SEARCH_QUERY_LIMITED`; defer FTS |
| FE/Java merge drift causes UI ≠ export | User distrust | Slice 2 contract thresholds; golden export tests |
| Evidence QA too strict → empty action plans | Product regression | Tunable `minScore` via policy; shadow logs |
| Domain pack / DB collision noise | Monitoring spam | `DOMAIN_LEXICON_COLLISION` P3 alert; `disabledTerms` |
| OpenAPI change breaks clients | Integration break | Additive paths only; generated client regen in CI |
| Corrupt `canonical_transcript_rows` JSONB | Bad readable transcript | Repair script §Data Migration; version mismatch fallback |
| Policy file missing in deploy | Wrong thresholds | `POLICY_LOAD_FALLBACK` → `default-policy.json`; restart for runtime policy |
| FE redeploy when `default-policy.json` changes | Unnecessary FE downtime | Prefer `transcript-quality-policy.json` runtime changes; document in deploy runbook (§5.2) |
| Backfill without `--rebuild-stats` | Broken Evidence QA (missing `idf`/`termFrequency`) | `--rebuild-stats` default on; dry-run gate before prod (§12) |
| `evidence_stats` missing → runtime error | Service crash on score | Fallback `idf=0.0` + `EVIDENCE_QA_STATS_MISSING`; backfill mandatory before flag enable |
| Stale canonical version after policy bump | Wrong readable until repair | Log + raw only; `backfill-canonical.py --rebuild-stats` batch |

---

## Rollout Plan

Align with spec §12:

1. Merge slices behind flags (default off).
2. Staging: enable `TRANSCRIPT_QUALITY_ENABLED`; smoke transcript parity.
3. **`backfill-canonical.py --dry-run`** on staging — confirm `evidence_stats.idf` + per-row `termFrequency` before production.
4. Gradual flag enable per slice; monitor `EPIC3` log bundle.

Per-slice rollback: set flag `false` → restart; data repair via backfill `--rebuild-stats`.

---

## Estimated Timeline

| Slice | Estimate | Subtasks |
|-------|----------|----------|
| 1 — Contract inventory | 0.5–1 day | policy JSON, schema, OpenAPI inventory |
| 2 — Transcript quality | **2.5 days** | (a) HTTP+Celery 1d, (b) processing client 0.5d, (c) FE 0.5d, (d) migration 0.25d, (e) backfill repair 0.25d |
| 3 — Domain lexicon | 2–3 days | packs, merge logic, FE cache by versionHash |
| 4 — Evidence QA | **1.5 days** | (a) scoring/dedupe 1d, (b) FE preview 0.5d |
| 5 — Search verify | 1–2 days | golden fixtures + OpenAPI search |
| 6 — Export verify | **1 day** | (a) `meeting-golden.json` + generate script 0.5d, (b) preflight 0.5d |
| E2E — Integration test | 0.5–1 day | `Epic3EndToEndIT` @ `epic3-e2e` profile |
| 7 — Observability | 0.5–1 day | log-bundle + alerts + smoke checklist |
| **Total** | **~9–14 dev days** | Parallelize Slice 3 after Slice 1 if 2 devs |

---

## Commit & PR conventions

- Message format: `feat(scope): description (#Epic3)`
- One commit per slice (recommended)
- Stage specific files only (`rtk git add <paths>`)
- Run tests per slice before next slice:
  - `rtk mvn test` (processing-service)
  - `rtk pytest` (ai-service relevant tests)
  - `rtk npm test` (FE-Audiomind)
- PR title: `feat: Transcript, Evidence & Export Quality (Epic 3)`

---

## Immediate next steps (after this doc merge)

1. Slice 1: policy + `default-policy.json` (copy from policy) + `sync-default-policy.sh` + `epic3-baseline-inventory.md` + FE `transcriptQualityDefaults.json` + `fallback-policy.ts` + `ConfigController` + `Epic3PolicyLoader` + `SecurityConfig.permitAll` for `GET /api/config/transcript-quality`.
2. Shared tokenizer utility (Python + Java `TokenizerUtil`) + golden tests.
3. ai-service: `/api/internal/.../canonicalize` + `/api/internal/.../transcript-quality` + Celery TF/IDF persist (`segment_id` snake_case, `build_canonical_transcript_hash()`, Redis in-flight key).
4. Slice 4: §5.3.3 mapping + `mergeStableSpeakerSegments` segmentId + `EVIDENCE_QA_STATS_MISSING` fallback + `5-segment-golden.json` (speakerBoost 1.1).
5. `backfill-canonical.py` with `--batch-size`, `--concurrency`, `--rebuild-stats`, `segment_id` generation.
6. OpenAPI: deprecate `GET /processing/transcript/{meetingId}`; add config endpoint.
7. `Epic3EndToEndIT` + `epic3-e2e` profile (`@MockBean` ai-service 202).

---

## Implementation notes

### TranscriptQualityContext (processing-service)

- Mở rộng `TranscriptPayload` hoặc companion `TranscriptQualityContext`: `canonicalTranscriptRows` (pre-stabilization), `evidenceStats`, `canonicalTranscriptVersion`.
- **Mapping layer:** `AIServiceClient` maps HTTP DTO (camelCase) → context; JSONB persist uses snake_case (`start_time`, `end_time`, `segment_id`, `term_frequency`, `segment_count`, `computed_at`, `canonical_version` in `evidence_stats`).
- Populate từ `GET /api/internal/meetings/{meetingId}/transcript-quality` response (§5.3.2); `ready=true` only when rows + stats + hash all non-null.
- `TranscriptEvidenceSearchService` nhận context — **không** query DB / không HTTP tại score time.
- `mergeStableSpeakerSegments`: carry first timeline `segmentId`; log `TRANSCRIPT_QUALITY_MERGE_NO_SEGMENT_ID` when missing.

### Epic3FeatureFlags + FE config (mirror Epic 2)

- Java: `Epic3FeatureFlags` với `@ConfigurationProperties(prefix = "epic3")` — cùng pattern `Epic2FeatureFlags`.
- FE: `configService.getTranscriptQualityPolicy()` — fetch ``${PROCESSING_API_BASE}/api/config/transcript-quality`` (processing-service owner) → bundled `transcriptQualityDefaults.json` → `FALLBACK_POLICY`.
- FE lexicon: ``${AI_INTERNAL_BASE}/api/config/lexicon?domain=`` (ai-service owner — §5.5); **không** mix với processing config base.
- `fallback-policy.ts` auto-generated bởi `scripts/sync-default-policy.sh` (không edit thủ công).

### Tokenizer utility (cross-language)

Tạo implementation riêng, **cùng golden vectors**:

| Runtime | Path (proposed) |
|---------|-----------------|
| FE | `packages/shared/tokenizer.ts` (hoặc `FE-Audiomind/src/utils/tokenizer.ts`) |
| Python | `ai-service/app/utils/tokenizer.py` |
| Java | `processing-service/.../TokenizerUtil.java` |

Slice 5: refactor `TranscriptEvidenceSearchService` search tokenization to call `TokenizerUtil` (single implementation).

Mỗi file có unit test golden: cùng input text → cùng list token normalized.

### Scoring golden (Java ↔ Python parity)

Fixture **`5-segment-golden.json`** trong `processing-service/src/test/resources/fixtures/` — 5 canonical rows với `term_frequency` + `evidence_stats.idf` (ln). So sánh score Java với script Python reference — đảm bảo `idf × tf × (1 - position_norm × positionNormDecay) × speaker_boost` khớp Appendix A §5.4 (`speakerBoost=1.1`).

### Feature flag guard

Khi implement mỗi method/path mới (canonicalize HTTP, scoring, search cap, export preflight, lexicon loader):

- Kiểm tra flag Epic 3 **ở đầu method** (`TRANSCRIPT_QUALITY_ENABLED`, `EVIDENCE_QA_ENABLED`, v.v.).
- Flag off → delegate ngay baseline code path; **no regression** so với behavior trước Epic 3.

### FE fallback constant

- Export `FALLBACK_POLICY` từ `FE-Audiomind/src/config/fallback-policy.ts` — nội dung **mirror** `default-policy.json` tại build time.
- Policy loader: endpoint fail → `transcriptQualityDefaults.json` → `FALLBACK_POLICY` (§5.2).
- Generate via `sync-default-policy.sh` (khuyến nghị) để tránh duplicate/maintain drift thủ công.
