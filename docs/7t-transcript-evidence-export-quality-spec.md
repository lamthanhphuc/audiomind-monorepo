---
title: "7T — Transcript, Evidence & Export Quality Spec"
status: SPEC-ONLY
scope: "Epic 3 (P0/P1): Transcript Quality, Evidence QA, Search Verify, Export Verify, Domain Lexicon"
updated: 2026-06-22
revision: 13
implementation_ready: true
branch: feat/transcript-evidence-export-quality
---

**Implementation-ready (rev 13):** Đủ để bắt đầu Slice 1–2 mà không cần quyết định kiến trúc thêm. Bản đồ file: §14. Artifacts Slice 1 tạo khi implement (chưa có trong repo).

## 1. Executive Summary

Epic 3 **Transcript, Evidence & Export Quality (P0/P1)** nâng chất lượng đầu ra sau STT/analysis mà user thực sự đọc, tìm kiếm và xuất file:

- **Transcript Quality**: transcript dễ đọc hơn — ít fragment nhiễu, merge hợp lý, canonical/speaker stabilization nhất quán giữa realtime, history và export.
- **Domain Lexicon**: từ vựng domain (luật, tài chính, y tế, IT, …) được quản lý thống nhất, ảnh hưởng STT hints, realtime keyword hits và FE highlight — không còn split-brain giữa DB glossary và `itTerms.ts` tĩnh.
- **Evidence QA**: evidence trích từ transcript phải đúng ngữ cảnh, dedupe, có metadata verify rõ; action plan/report không cite “ảo”.
- **Search Verify**: transcript evidence search trả kết quả chính xác, đúng meeting scope, ranking ổn định với tiếng Việt.
- **Export Verify**: DOCX/TXT/CSV export sạch, đủ field, không thiếu evidence note, không leak raw nhiễu.

Không redesign UI lớn; ưu tiên **no regression** cho upload, realtime, analysis, export hiện có.

---

## 2. Current Production Baseline (code-grounded)

### 2.1 Transcript pipeline

| Stage | Location | Behavior |
|-------|----------|----------|
| Raw STT | ai-service `TranscriptFragment`, `Transcript` rows | Partial/overlapping segments |
| Canonical | `ai-service/app/services/transcript_canonicalizer.py` | Dedupe, drop contained, merge adjacent (`canonical-transcript-v2`) |
| Canonical persist (today) | `Transcript` sidecar columns | `canonical_transcript_rows` on `transcripts` — **often via backfill**, not hot-path |
| Canonical persist (Epic 3 target) | `meeting_analysis_runs.canonical_transcript_rows` | JSONB column — hot-path write on STT finalize when `TRANSCRIPT_QUALITY_ENABLED` |
| Readable source | `ProcessingService.selectReadableTranscriptSource()` | See §5.3 priority order (Epic 3); when flag on: HTTP `GET .../transcript-quality` (§5.3.2); today: ai canonical → job_state → ai persisted |
| Speaker stabilization | `ProcessingService.stabilizeReadableTranscriptRows()` | Island/tiny-fragment merge; config `speaker.stabilization.*` (enabled by default) |
| FE live | `transcript.ts` + `App.tsx` | `mergeTranscriptSegmentsForDisplay`, partial/final dedupe |
| FE history | `TranscriptDisplay.tsx`, `MeetingHistoryScene.tsx` | `normalizePersistedTranscriptForView`, optional `groupUploadTranscriptSegmentsForDisplay` |
| Metadata UI | `AnalysisStatusPanel.tsx` | Canonical hash/version, analysis status — **no evidence UI** |

**Gap:** live vs history dùng merge heuristics khác nhau; canonical sidecar không auto-persist trên mọi meeting.

### 2.2 Evidence

- **Không có** `EvidenceService` hay bảng evidence riêng.
- Engine: `TranscriptEvidenceSearchService.java` — in-memory scan trên stabilized readable rows.
- DTOs: `TranscriptEvidenceMatch`, `TranscriptSearchResponse`.
- Verification: `MeetingActionPlanBuilder` → `resolveActionPlanEvidence()` — top-1 search match per action item.
- **Epic 3 storage:** không persist evidence table riêng; gắn vào `analysis` JSON response dưới field `evidence` (§5.4).
- API: `GET /processing/{meetingId}/transcript/search?q=&limit=&context=`.
- FE: `MeetingHistoryScene.tsx` hiển thị kết quả search; action plan preview chỉ show `evidenceKeywords`, **không** render verified `evidence` object.
- DOCX: `MeetingActionPlanDocxGenerator`, `MeetingReportDocxGenerator` có cột/note evidence (partial).

### 2.3 Export

| Type | Format | Endpoint | Generator |
|------|--------|----------|-----------|
| Transcript readable/raw | TXT, CSV | `GET /processing/{meetingId}/transcript/export` | `ProcessingService.generateMeetingTranscriptTxt/Csv` |
| Meeting report | DOCX | `GET /processing/{meetingId}/report?format=docx` | `MeetingReportDocxGenerator` |
| Action plan preview | JSON | `GET /processing/{meetingId}/action-plan` | `MeetingActionPlanBuilder` |
| Action plan export | DOCX | `GET /processing/{meetingId}/action-plan/export` | `MeetingActionPlanDocxGenerator` |
| PDF | — | **Not implemented** | Spec-only |

FE export UI: `MeetingHistoryScene.tsx` + `api.ts` (`downloadMeetingReport`, `downloadMeetingTranscript`, `downloadMeetingActionPlanDocx`).

**Gap:** `packages/contracts/processing-api.yaml` thiếu `/transcript/search`, `/action-plan`; PDF deferred.

### 2.4 Search

- In-memory normalized substring/phrase search (no DB index, no embeddings).
- **Diacritic normalization algorithm** (query + segment text, implement identically Java/Python/FE):
  1. Unicode **NFD** decomposition
  2. Remove combining diacritical marks **U+0300–U+036F**
  3. Map Vietnamese **`đ` → `d`** and **`Đ` → `D`** (outside standard NFD strip)
  4. Lowercase for case-insensitive match
- **Tokenizer cho TF-IDF:** Khi tính `termFrequency` (ai-service persist) và khi search/score (Java), dùng **cùng** tokenizer:
  - Tách từ bằng regex `\b\w+\b` — Python: `re.findall(r'\b\w+\b', text)`; Java: `Pattern.compile("\\b\\w+\\b")`.
  - Sau khi tách, áp dụng diacritic normalization (bước 1–4 ở trên) và lowercase cho **mỗi token**.
  - Token trùng trong cùng segment gộp vào `termFrequency` map (count).
  - Token tối thiểu 1 ký tự; **không** lọc stopword trong MVP.
- Phrase mode (≥4 chars) vs token mode; ranking phrase > token > position (baseline — unchanged unless `SEARCH_VERIFY_ENABLED`; see §5.4 dual-mode).
- Auth: `assertMeetingAccess` + meeting-service ownership.
- Logging: `event=TRANSCRIPT_SEARCH_REQUEST` (query hash prefix, không log full query).
- Tests: `ProcessingServiceTranscriptSearchTest.java`, FE `MeetingHistoryScene.test.tsx`.

**Gap:** không có cross-meeting search; spec cũ (`7t-search-a-...`) vẫn ghi `SPEC-ONLY` dù code đã ship.

### 2.5 Domain lexicon / glossary

| Source | Location | Used for |
|--------|----------|----------|
| DB glossary | ai-service `glossary_service.py`, `glossary_repository.py` | STT batch, analysis version ref, realtime `keyword_matcher.py` |
| FE static IT terms | `FE-Audiomind/src/constants/itTerms.ts` | `HighlightedTranscriptText.tsx` — **không sync DB** |
| Realtime hits | `useRealtimeMeetingStream.ts` `keyword.hit` | Backend matcher events |

**Gap:** không có admin API/public config cho domain packs; FE và backend lexicon tách rời.

### 2.6 Feature flags hiện có (không phải Epic 3)

- `speaker.stabilization.enabled` (+ version, thresholds) — processing-service `application.yml`
- `epic2.*` — error/upload/realtime validation (Epic 2)
- Không có `TRANSCRIPT_QUALITY_ENABLED`, `DOMAIN_LEXICON_ENABLED`, v.v.

### 2.7 Related prior specs (có drift)

- `docs/specs/canonical-transcript-pipeline.md`
- `docs/specs/phase-7s-speaker-stabilization.md`
- `docs/specs/7t-search-a-transcript-evidence-search-spec.md` (SPEC-ONLY label, code exists)
- `docs/specs/7t-export-a-meeting-action-plan-export-spec.md`
- `docs/specs/7t-f8-search-export-integration-plan.md`
- `docs/specs/7t-qa-f9-gate5-realtime-search-export-hardening-spec.md`

Epic 3 spec/plan này là **source of truth mới**; các spec cũ được tham chiếu, không duplicate toàn bộ.

---

## 3. Problem Statement

### 3.1 User-facing

- Transcript đôi khi còn fragment ngắn, lặp, speaker label không ổn định giữa màn hình live và history.
- Tìm keyword trong transcript có thể trả match nhiễu hoặc thiếu ngữ cảnh; user khó tin citation trong action plan.
- Export DOCX/CSV đôi khi không khớp những gì user thấy trên UI (readable vs raw, evidence note).
- Thuật ngữ domain (luật, tài chính, y tế) chưa được quản lý tập trung — highlight STT và highlight FE không đồng bộ.

### 3.2 Engineering

- Canonical sidecar phụ thuộc backfill → search/export/analysis có thể đọc raw trong khi UI đã “đẹp hơn” nhờ stabilization.
- Evidence computed on-demand, không persist → không audit trail; action plan re-verify mỗi lần.
- Contract OpenAPI không cover search/action-plan → client drift risk.
- Nhiều merge code paths (FE live, FE history, Java stabilization, Python canonicalizer) khó regression-test end-to-end.

---

## 4. Non-Goals

- PDF export (defer; giữ DOCX/TXT/CSV).
- Cross-meeting / global semantic search, embeddings, vector DB.
- PostgreSQL FTS migration trong Epic 3 MVP (interface-ready only).
- UI redesign lớn (chỉ thêm evidence/quality surfaces cần thiết).
- Thay STT/AI provider.
- Billing/quota.

---

## 5. Architecture Decision

### 5.1 Slice model + feature flags

Epic 3 chia **7 TDD slices**, mỗi slice có feature flag riêng (default `false`). Khi flag off → **baseline path** hiện tại, không đổi behavior.

| Flag | Slice | Scope |
|------|-------|-------|
| _(none)_ | 1 | Contract inventory only |
| `TRANSCRIPT_QUALITY_ENABLED` | 2 | Canonical hot-path + FE/Java merge alignment |
| `DOMAIN_LEXICON_ENABLED` | 3 | Domain packs API + FE/backend sync |
| `EVIDENCE_QA_ENABLED` | 4 | Evidence scoring, dedupe, verify metadata |
| `SEARCH_VERIFY_ENABLED` | 5 | Search ranking/guard hardening + contract tests |
| `EXPORT_VERIFY_ENABLED` | 6 | Export snapshot verify + DOCX/CSV cleanup |
| _(none)_ | 7 | Observability + smoke scripts |

Flags đọc từ env (Java `Epic3FeatureFlags`, FE build-time + runtime config endpoint nếu cần).

#### Feature flag interaction matrix

| Flags on | Search ranking | Export preflight | Source priority | Notes |
|----------|----------------|------------------|-----------------|-------|
| chỉ `TRANSCRIPT_QUALITY` | existing | existing | new priority (canonical) | no scoring |
| thêm `EVIDENCE_QA` | scoring + dedupe; **search ranking unchanged** (§5.4 dual-mode) | existing | new priority | scores in analysis; list order legacy |
| thêm `SEARCH_VERIFY` | cap scan + stricter guards (§5.7) | existing | new priority | log `SEARCH_QUERY_LIMITED`, `TRANSCRIPT_SEARCH_REJECTED` |
| thêm `EXPORT_VERIFY` | as above | preflight | new priority | compare metadata |
| tất cả flags off | baseline | baseline | baseline | no changes |

### 5.2 Shared contract artifact (Slice 1)

**Primary:** `packages/contracts/transcript-quality-policy.json`

Fields tối thiểu:

```json
{
  "version": "1.0.0",
  "transcript": {
    "canonicalVersion": "canonical-transcript-v2",
    "shortSegmentMaxWords": 3,
    "mergeMaxGapSeconds": 5,
    "displayGroupingEnabled": true
  },
  "search": {
    "minQueryLength": 2,
    "minTokenLength": 2,
    "maxLimit": 50,
    "maxContext": 3,
    "phraseMinLength": 4,
    "maxScanSegments": 2000,
    "scanPreference": "recent"
  },
  "evidence": {
    "minScore": 0.35,
    "dedupeWindowSeconds": 2.0,
    "maxMatchesPerActionItem": 1,
    "speakerBoost": 1.1,
    "positionNormDecay": 0.5
  },
  "export": {
    "supportedFormats": ["txt", "csv", "docx"],
    "defaultTranscriptMode": "readable",
    "includeEvidenceNotes": true
  },
  "lexicon": {
    "defaultDomainPack": "general",
    "supportedDomainPacks": ["general", "legal", "finance", "healthcare", "it"],
    "disabledTerms": []
  }
}
```

Validate trong `packages/tooling/config-validation/` (CI contract-check).

**Default Policy Artifact:** `packages/contracts/default-policy.json` — **source of truth** cho fallback khi deploy policy thiếu hoặc parse fail. Nội dung **đồng bộ** với `transcript-quality-policy.json` (cùng schema); CI đảm bảo hai file khớp nhau hoặc `default-policy.json` là subset an toàn.

| Consumer | Load order |
|----------|------------|
| processing-service (Java) | `transcript-quality-policy.json` → on fail: `default-policy.json` → log `POLICY_LOAD_FALLBACK` |
| ai-service (Python) | same |

**FE-Audiomind — load order (chi tiết):**

| Priority | Source | Mô tả |
|----------|--------|--------|
| 1 | `config endpoint` (`transcript-quality-policy.json`) | Fetch từ backend tại runtime |
| 2 | `bundled transcriptQualityDefaults.json` | Sinh từ `default-policy.json` khi build (`sync-default-policy.sh`) |
| 3 | `hardcoded fallback` | Last resort; **giống nội dung `default-policy.json`** tại thời điểm codegen — ví dụ `FALLBACK_POLICY` trong `FE-Audiomind/src/config/fallback-policy.ts` |

**FE load order (tóm tắt):** `config endpoint` → `bundled default-policy.json` (`transcriptQualityDefaults.json`) → `hardcoded fallback` (last resort).

**Hardcoded fallback (ghi chú):** Là bản sao tĩnh của `default-policy.json` tại thời điểm generate source. Nếu `default-policy.json` thay đổi mà FE **không** rebuild, hardcoded fallback có thể **khác** bundle và runtime policy. Hardcoded fallback chỉ là cứu cánh cuối cùng — **không khuyến khích** dùng trong production.

**Policy load fallback:** Nếu `transcript-quality-policy.json` không load được (missing file, parse error, schema fail) → load **`packages/contracts/default-policy.json`**; log `POLICY_LOAD_FALLBACK` (reason, path, fallbackPath). FE: config endpoint fail → `transcriptQualityDefaults.json`; bundle parse fail → `FALLBACK_POLICY` constant (last resort).

**Policy reload (MVP):** Policy load **một lần khi startup** (Java `Epic3PolicyLoader`, ai-service config module, FE bundled defaults). Thay đổi policy file **yêu cầu restart service** trong MVP.

- Runbook: *policy changes require service restart in MVP*.
- **TODO (post-MVP):** Spring Cloud Config + `/actuator/refresh` (processing-service); optional file-watch reload for ai-service policy path.

**Operational Constraint (FE):** Vì `default-policy.json` được **bundle tĩnh** trong FE-Audiomind (`transcriptQualityDefaults.json`), bất kỳ thay đổi nào ở file này **đều yêu cầu FE rebuild và redeploy** (tương đương restart backend). Với thay đổi cấu hình vận hành (ví dụ tăng `maxScanSegments`), **ưu tiên** sửa `transcript-quality-policy.json` (fetch runtime qua config endpoint) thay vì `default-policy.json` để tránh downtime FE không cần thiết.

**FE build integration:** `default-policy.json` phải được copy vào `FE-Audiomind/src/config/transcriptQualityDefaults.json` trong quá trình build (script `scripts/sync-default-policy.sh` trước `npm run build`). CI kiểm tra file tồn tại và khớp schema. Tùy chọn (khuyến nghị): script cũng generate `FE-Audiomind/src/config/fallback-policy.ts` (`export const FALLBACK_POLICY = ...`) từ cùng nguồn để tránh drift thủ công.

**Config endpoint (mirror Epic 2):**

| Item | Value |
|------|-------|
| Service | **processing-service** |
| Method / path | `GET /api/config/transcript-quality` |
| Auth | **Public read** — `permitAll` (no JWT required) |
| SecurityConfig | `requestMatchers(HttpMethod.GET, "/api/config/transcript-quality").permitAll()` in processing-service `SecurityConfig` |
| Response body | Full `transcript-quality-policy.json` payload (or subset validated by schema) |
| Cache | FE in-memory cache after first successful fetch |

**FE `configService` load order:** `fetch` runtime endpoint → bundled `transcriptQualityDefaults.json` → `FALLBACK_POLICY` constant (`fallback-policy.ts`, auto-generated by `sync-default-policy.sh`).

```typescript
// FE-Audiomind/src/services/configService.ts (extend — mirror Epic 2 getUploadConfig)
import transcriptQualityDefaults from '../config/transcriptQualityDefaults.json'
import { FALLBACK_POLICY } from '../config/fallback-policy'
import { PROCESSING_API_BASE } from './config'

export type TranscriptQualityPolicy = typeof transcriptQualityDefaults

let cachedTranscriptQualityPolicy: TranscriptQualityPolicy | null = null

export const getBundledTranscriptQualityPolicy = (): TranscriptQualityPolicy => ({
  ...transcriptQualityDefaults,
})

export const getTranscriptQualityPolicy = async (): Promise<TranscriptQualityPolicy> => {
  if (cachedTranscriptQualityPolicy) {
    return cachedTranscriptQualityPolicy
  }
  try {
    const response = await fetch(`${PROCESSING_API_BASE}/api/config/transcript-quality`)
    if (!response.ok) {
      throw new Error(`transcript-quality policy status ${response.status}`)
    }
    const payload = (await response.json()) as Partial<TranscriptQualityPolicy>
    cachedTranscriptQualityPolicy = {
      ...getBundledTranscriptQualityPolicy(),
      ...payload,
    }
    return cachedTranscriptQualityPolicy
  } catch {
    cachedTranscriptQualityPolicy = FALLBACK_POLICY
    return cachedTranscriptQualityPolicy
  }
}
```

Java consumer: `ConfigController` + `Epic3PolicyLoader` loads file at startup; endpoint serves same artifact for FE runtime refresh without redeploy. `SecurityConfig` must permit unauthenticated `GET` (see table above).

### 5.3 Async canonical persist & readable source priority

**Trigger points** (khi `TRANSCRIPT_QUALITY_ENABLED=true`):

| Trigger point | Meeting type | Flag guard | Behavior |
|---------------|--------------|------------|----------|
| `MeetingWebSocketHandler.finalizeSttSession()` | Realtime | `TRANSCRIPT_QUALITY_ENABLED` | **Fire-and-forget** `POST` canonicalize sau khi STT session đóng thành công (không block WebSocket thread); `runId=null` (§5.3.1) |
| `ProcessingService.processMeeting()` completion | Upload/batch | `TRANSCRIPT_QUALITY_ENABLED` | `POST` canonicalize sau `aiServiceClient.processAudio()` return success (terminal job); optional `runId` từ analysis run nếu có |

**Hook placement (exact — Slice 2):**

| Location | File | Insert after | Guard |
|----------|------|--------------|-------|
| Realtime finalize success | `MeetingWebSocketHandler.java` ~L1280 (`event=REALTIME_FINALIZE_COMPLETE`) | `triggerRealtimeAnalysisAsync(...)` — **cùng nhánh** `!partial` | `Epic3FeatureFlags.transcriptQualityEnabled` |
| Realtime skip-low-value path | `MeetingWebSocketHandler.java` ~L1203 | `triggerRealtimeAnalysisAsync(...)` khi `shouldSkipLowValueFinalEvent` nhưng vẫn trigger analysis | same |
| Upload/batch | `ProcessingService.java` ~L327 | `return aiResponse` trong `processMeeting(...)` — sau `processAudio` success | same |

Gọi `aiServiceClient.requestCanonicalize(meetingId, null, traceId)` — **async** (`@Async` hoặc `CompletableFuture.runAsync`); không block WebSocket / HTTP thread. Log `TRANSCRIPT_QUALITY_CANONICALIZE_ENQUEUED` (`meetingId`, `runId`, `source=realtime|upload`).

**Celery task naming (canonical):**

| Item | Value |
|------|-------|
| Module | `ai-service/app/tasks.py` |
| Registered name | `app.tasks.canonicalize_and_persist` |
| Python function | `canonicalize_and_persist` |
| Deferred retry | `app.tasks.canonicalize_deferred_retry` — `meeting_id`, `attempt` (1–5); schedule +5s between attempts |
| Distinct from | `app.tasks.process_meeting`, `app.tasks.analysis_retry_scheduled` |

Enqueue sau meeting terminal; **không** gộp logic vào `process_meeting`.

**Task retry (transient failures):**

```python
@celery_app.task(
    name="app.tasks.canonicalize_and_persist",
    autoretry_for=(Exception,),
    retry_backoff=60,
    max_retries=3,
)
def canonicalize_and_persist(meeting_id: int, run_id: int) -> None: ...
```

Sau `max_retries` exhausted → log `TRANSCRIPT_QUALITY_PERSIST_FAILED`; read path dùng raw fallback.

**Persist trigger (Slice 2):** Khi `TRANSCRIPT_QUALITY_ENABLED=true`, sau STT finalize / meeting terminal **không block** user flow:

1. **processing-service** gọi ai-service internal HTTP (§5.3.1) — **không** enqueue Celery trực tiếp từ Java.
2. **ai-service** HTTP handler enqueue Celery **`canonicalize_and_persist`** (`app.tasks.canonicalize_and_persist`).
3. Task body: `canonicalize_segments()` → tính `term_frequency` (per segment) + `idf` map (per run) → persist **`canonical_transcript_rows`**, **`evidence_stats`**, **`canonical_transcript_version`** (§5.4) + cập nhật `canonical_transcript_hash`.

**Async fallback (chỉ khi Celery broker/worker không sẵn sàng):**

| Runtime | Fallback | Ghi chú |
|---------|----------|---------|
| ai-service | `asyncio.create_task(...)` trong event loop | Dev/single-process only khi HTTP handler không dùng Celery; log `TRANSCRIPT_QUALITY_ASYNC_FALLBACK` |
| processing-service | — | **Không** enqueue Celery / `@Async` persist — chỉ gọi HTTP §5.3.1 |

**Task failure:** Log `TRANSCRIPT_QUALITY_PERSIST_FAILED` (`meetingId`, `errorCode`, `durationMs`); **không** fail meeting; read path fallback raw (§5.3 read priority).

**Metrics:**

- `canonical_persist_duration_ms` — histogram từ task start → DB commit (Celery worker).
- Counter `canonical_persist_success` / `canonical_persist_failed`.

**Canonical read path:** `ProcessingService.selectReadableTranscriptSource()` khi `TRANSCRIPT_QUALITY_ENABLED=true` gọi **`GET /api/internal/meetings/{meetingId}/transcript-quality`** (§5.3.2):

| Condition | Log marker | Fallback |
|-----------|------------|----------|
| `ready=false` (canonical chưa persist xong) | `TRANSCRIPT_QUALITY_NOT_READY` (`meetingId`, `reason`) — ví dụ `celery_pending`, `rows_empty` | priority #2 raw |
| `ready=true` nhưng `canonicalTranscriptVersion` ≠ policy | `TRANSCRIPT_QUALITY_VERSION_MISMATCH` (`meetingId`, `storedVersion`, `expectedVersion`) | priority #2 raw |
| `ready=true`, version match, rows non-empty | — | `analysis_run_canonical` (§ priority table) |

- **Không có cơ chế auto-re-enqueue** trong cả hai trường hợp trên — không enqueue Celery, không gọi HTTP canonicalize lại. **Chỉ log + fallback raw.**
- **Repair duy nhất:** `scripts/backfill-canonical.py` (§9.2) — batch sau policy bump, corrupt JSONB, hoặc trước staging/prod rollout.

**`ProcessingService.selectReadableTranscriptSource()` priority** (khi `TRANSCRIPT_QUALITY_ENABLED=true`):

| Order | Source | Condition | `sourceReason` |
|-------|--------|-----------|----------------|
| 1 | ai-service `GET .../transcript-quality` | Flag on **and** `ready=true` **and** version match **and** rows non-empty | `analysis_run_canonical` |
| 2 | `job_state` raw rows | Non-empty | `processing_job_state` |
| 3 | ai-service persisted transcript | Non-empty readable/raw rows | `ai_persisted_transcript` |

Khi flag **off** → giữ behavior hiện tại (ai persisted canonical → job_state → ai persisted).

Sau khi chọn source → `stabilizeReadableTranscriptRows()` (speaker.stabilization.*) → consumers (search, export, FE).

```text
STT finalize / meeting terminal (non-blocking)
  → [Java] POST ai-service /api/internal/meetings/{meetingId}/canonicalize → 202 { taskId }
  → [Python] enqueue Celery: app.tasks.canonicalize_and_persist
      → canonicalize_segments
      → compute term_frequency (per row) + idf map → evidence_stats
      → persist canonical_transcript_rows + evidence_stats + canonical_transcript_version
      → metric: canonical_persist_duration_ms
  → [Java] selectReadableTranscriptSource — HTTP GET §5.3.2 (version check + priority)
      → on not ready: TRANSCRIPT_QUALITY_NOT_READY; on version mismatch: TRANSCRIPT_QUALITY_VERSION_MISMATCH; raw fallback only
  → [Java] stabilizeReadableTranscriptRows + §5.3.3 canonical mapping
  → [FE] normalize + merge for display
  → Search / Export / Action Plan evidence
```

### 5.3.1 Internal HTTP Endpoint

**Owner:** ai-service. **Caller:** processing-service (sau meeting terminal khi `TRANSCRIPT_QUALITY_ENABLED`).

| Item | Value |
|------|-------|
| Method / path | `POST /api/internal/meetings/{meetingId}/canonicalize` |
| Auth | Internal service token / network boundary (same pattern as existing ai-service internal routes) |
| Request body | Optional: `{ "runId": <int>, "force": false }` |
| Success response | **`202 Accepted`** — `{ "taskId": "<celery-task-id>" }` |
| Error | `4xx/5xx` — processing-service logs; read path dùng raw fallback; không fail meeting |

**`runId` selection (khi request không gửi `runId` — ví dụ realtime `finalizeSttSession()`):**

1. **First attempt:** latest run **any status** (không lọc `completed`/`failed`):

```sql
SELECT id FROM meeting_analysis_runs
WHERE meeting_id = :meetingId
ORDER BY updated_at DESC
LIMIT 1;
```

2. **Nếu không có run:** enqueue Celery **`app.tasks.canonicalize_deferred_retry`** (`meeting_id`, `attempt=1`) — retry sau **5s**, tối đa **5** lần (mỗi lần re-query run). Hoặc `asyncio` timer tương đương trong dev single-process.
3. **Sau 5 lần vẫn không có run:** log `TRANSCRIPT_QUALITY_SKIP_NO_RUN` (`meetingId`, `attemptCount`); **không** enqueue; trả **`202 Accepted`** với `taskId` rỗng (hoặc `404` nếu caller yêu cầu strict — processing-service coi như skip).

**Decision:** Realtime STT finalize thường xảy ra **trước** analysis run được tạo. Cho phép resolve run **bất kỳ status** + deferred retry tránh race; không fail meeting flow.

**`canonical_transcript_hash` (idempotency key):**

- Tính bằng **SHA-256** (hex lowercase, 64 chars) — **reuse** `build_canonical_transcript_hash()` trong `ai-service/app/services/transcript_canonicalizer.py`:

```python
SHA256(
  json.dumps(canonical_rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
  + canonicalTranscriptVersion
)
```

- Input `canonical_rows` = output của `canonicalize_segments()` — **chỉ** `text`, `speaker`, `start_time`, `end_time` (timeline order). **Không** sort theo `segmentId`; hash **không** gồm `termFrequency`, `segmentId`, hay field phụ.
- Chỉ thay đổi khi nội dung canonical thay đổi (policy bump, tokenizer thay đổi, re-canonicalize).
- Lưu vào `meeting_analysis_runs.canonical_transcript_hash` (cột đã có migration 006).

**Idempotency (persisted hash + in-flight guard):**

| Layer | Key / rule | Behavior |
|-------|------------|----------|
| **Pre-enqueue preview** | Sync `canonicalize_segments()` trong HTTP handler | Tính hash; so với `canonical_transcript_hash` đã persist trên run → nếu khớp → skip (log `TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP`, `reason=persisted`) |
| **In-flight Redis** | `canonicalize:{meetingId}:{runIdOrNone}:{hash}` TTL **10 min** | `runIdOrNone` = `str(runId)` hoặc literal **`none`** khi `runId` null. Key **exists** → skip enqueue, log `TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP` (`reason=in_flight`); vẫn **`202 Accepted`**. Key **absent** → `SET` key → enqueue Celery; TTL hết tự nhiên (không cần explicit delete) |
| **Persisted** | `meeting_id` + `run_id` + `canonical_transcript_hash` | Hash đã commit cho run → skip duplicate enqueue (`reason=persisted`) |

| Skip action | Log `TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP` (`meetingId`, `runId`, `canonicalTranscriptHash`, **`reason`**: `persisted` \| `in_flight`); vẫn trả **`202 Accepted`** với `taskId` rỗng hoặc last known task id |
| Policy bump (hash khác) | Enqueue task mới — canonical version / tokenizer thay đổi → hash mới → rebuild bắt buộc |

**At-most-once enqueue:** Redis in-flight key + persisted hash đảm bảo **tối đa một** Celery task active cho mỗi combo `meeting_id` + `run_id` + `canonical_transcript_hash`. Hai trigger points (§5.3) gọi HTTP gần nhau → lần đầu set Redis + enqueue; lần sau `in_flight` hoặc `persisted` skip + `TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP` (vẫn 202).

**Flow:**

1. processing-service → `POST /api/internal/meetings/{meetingId}/canonicalize` (optional `runId`)
2. ai-service resolves run (§ trên) → checks idempotency hash → enqueue `canonicalize_and_persist` hoặc skip
3. Celery worker executes persist (§5.3)

**Redis client:** Reuse cùng Redis URL với Celery broker / `job_status_store._get_client()` (`settings.redis_url`) — không thêm dependency mới.

**AIServiceClient (processing-service) — methods mới:**

| Method | HTTP | Notes |
|--------|------|-------|
| `requestCanonicalize(meetingId, runId, traceId)` | `POST /api/internal/meetings/{id}/canonicalize` | Fire-and-forget; swallow 4xx/5xx; log only |
| `getTranscriptQuality(meetingId, traceId)` | `GET /api/internal/meetings/{id}/transcript-quality` | Map camelCase DTO → `TranscriptQualityContext` |

processing-service **không** import Celery client; mọi async work ở ai-service.

### 5.3.2 Cross-service read contract (ai-service → processing-service)

**Owner:** ai-service. **Caller:** `ProcessingService.selectReadableTranscriptSource()` khi `TRANSCRIPT_QUALITY_ENABLED=true`.

| Item | Value |
|------|-------|
| Method / path | `GET /api/internal/meetings/{meetingId}/transcript-quality` |
| Alternative (legacy bridge) | `GET /api/meeting/{id}/transcript?includeQuality=true` — chỉ dùng nếu internal route chưa deploy; spec ưu tiên internal path |
| Auth | Internal service token / network boundary |
| Success | **`200 OK`** — DTO bên dưới |
| Not ready | **`200 OK`** `{ "ready": false }` hoặc **`404`** — processing-service fallback priority #2 |

**`ready` semantics:**

| `ready` | Condition |
|---------|-----------|
| `true` | `canonical_transcript_rows` **NOT NULL** **AND** `evidence_stats` **NOT NULL** **AND** `canonical_transcript_hash` **NOT NULL** trên resolved `meeting_analysis_runs` row |
| `false` | Bất kỳ cột trên NULL — ví dụ Celery task **in-flight** trước DB commit; log `TRANSCRIPT_QUALITY_NOT_READY` (`reason=celery_pending`) |

**Row naming (JSONB persist vs HTTP DTO):**

| Layer | Convention | Fields |
|-------|------------|--------|
| **JSONB persist** (`meeting_analysis_runs.canonical_transcript_rows`) | **snake_case** | `start_time`, `end_time`, `segment_id`, `text`, `speaker`, `term_frequency` |
| **Internal HTTP DTO** (§ response sample) | **camelCase** | `startTime`, `endTime`, `segmentId`, `termFrequency` — ai-service serializes; **Java `AIServiceClient`** maps snake ↔ camel |
| **`TranscriptQualityContext`** (processing-service) | camelCase in-memory | Stores **pre-stabilization** canonical rows from DTO; **mapping layer** converts DTO → context fields before `stabilizeReadableTranscriptRows()` |

**Response DTO (sample — camelCase HTTP):**

```json
{
  "meetingId": 12345,
  "canonicalTranscriptVersion": "canonical-transcript-v2",
  "canonicalTranscriptRows": [
    {
      "segmentId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "text": "Hợp đồng luật sư đã ký",
      "speaker": "SPEAKER_1",
      "startTime": 12.5,
      "endTime": 15.2,
      "termFrequency": {
        "hop_dong": 1,
        "luat_su": 1
      }
    }
  ],
  "evidenceStats": {
    "idf": {
      "hop_dong": 0.693,
      "luat_su": 0.405
    },
    "segmentCount": 42,
    "computedAt": "2026-06-22T10:00:00Z",
    "canonicalVersion": "canonical-transcript-v2"
  },
  "ready": true
}
```

**processing-service read path:** `selectReadableTranscriptSource()` gọi endpoint này (thay vì đọc JSONB trực tiếp từ DB shared) khi flag on — giảm coupling schema Alembic giữa hai service.

**`TranscriptQualityContext` (processing-service):** Khi nhận response 200 + `ready=true`, processing-service **phải** lưu (via **DTO → context mapping layer** — camelCase):

| Field | Source | Purpose |
|-------|--------|---------|
| `canonicalTranscriptRows` | DTO `canonicalTranscriptRows` | **Pre-stabilization** canonical rows — lookup `termFrequency`, `segmentId`, canonical index |
| `evidenceStats` | DTO `evidenceStats` | Lookup `idf[term]`, `segmentCount` |
| `canonicalTranscriptVersion` | DTO | Version check |

Gắn vào `TranscriptPayload` (mở rộng record) hoặc `TranscriptQualityContext` riêng truyền cùng `TranscriptSourceDecision`. **`TranscriptEvidenceSearchService` dùng context này** — **không** query DB, **không** gọi lại ai-service tại scoring time (§5.4). Mapping layer **không** áp dụng speaker stabilization — stabilization chạy sau trên readable rows.

Sau khi build readable rows từ canonical → `stabilizeReadableTranscriptRows()` → §5.3.3 mapping stabilized → canonical row khi score.

### 5.3.3 Stabilization vs canonical rows alignment (Option D)

Stabilization (`stabilizeReadableTranscriptRows`) có thể merge/split segment so với canonical rows đã persist. Evidence scoring cần map **stabilized segment → canonical segment** để lookup `termFrequency` và `position_norm`.

**Mapping priority:**

| Order | Rule | Action |
|-------|------|--------|
| 1 | `segmentId` exact match | Dùng canonical row tương ứng |
| 2 | Time overlap ≥ **50%** (intersection duration / min(stab duration, canon duration)) | Dùng canonical row overlap cao nhất |
| 3 | No match | Log `TRANSCRIPT_QUALITY_SEGMENT_MAP_MISSING` (`meetingId`, `stabilizedStart`, `stabilizedEnd`, `speaker`); **skip scoring** cho segment đó (search vẫn substring match; không attach TF-IDF score) |

**Persist invariant:** Mỗi canonical row **phải** có `segment_id` (JSONB) / `segmentId` (DTO, UUID v4). Celery `canonicalize_and_persist` gán `segment_id` khi persist.

**`mergeStableSpeakerSegments` (speaker stabilization):** Khi merge adjacent stabilized rows, **giữ `segmentId` của segment đầu tiên** theo timeline (first in merge group). Nếu segment đầu thiếu `segmentId` → log `TRANSCRIPT_QUALITY_MERGE_NO_SEGMENT_ID` (`meetingId`, `mergedStart`, `mergedEnd`, `speaker`); evidence mapping fallback §5.3.3 overlap rule.

**Backfill:** Rows thiếu `segment_id` → script backfill generate UUID mới per row trước khi rebuild stats (§9.2).

### 5.4 Evidence QA model

Khi `EVIDENCE_QA_ENABLED`:

- `TranscriptEvidenceMatch` bổ sung: `verificationStatus` (`verified` | `weak` | `unverified`), `score`, `dedupeKey`.
- `MeetingActionPlanBuilder` reject/demote matches dưới `minScore` (configurable via policy); dedupe matches trong `dedupeWindowSeconds`.
- Weak matches → `unverifiedEvidenceNote` thay vì silent pass.
- Export generators chỉ in “Verified transcript evidence” khi `verificationStatus=verified`.

**Evidence stats storage (persist time — ai-service `canonicalize_and_persist`):**

TF-IDF là giá trị gắn với **cặp (term, segment)** — **không** lưu scalar `precomputedTfIdfWeight` per row (đã loại bỏ rev 5).

1. **Per-segment** — trong `meeting_analysis_runs.canonical_transcript_rows` (JSONB array), mỗi row **phải** có `term_frequency` (map): tần suất từng normalized term trong segment đó.

```json
{
  "text": "Hợp đồng luật sư đã ký",
  "speaker": "SPEAKER_1",
  "segment_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "start_time": 12.5,
  "end_time": 15.2,
  "term_frequency": {
    "hop_dong": 1,
    "luat_su": 1
  }
}
```

2. **Per-run** — cột JSONB `meeting_analysis_runs.evidence_stats` (persist **snake_case**; HTTP DTO camelCase §5.3.2):

```json
{
  "idf": {
    "hop_dong": 0.693,
    "luat_su": 0.405
  },
  "segment_count": 42,
  "computed_at": "2026-06-22T10:00:00Z",
  "canonical_version": "canonical-transcript-v2"
}
```

- `globalIdf(term)` = **`ln(totalSegments / max(1, segmentsContainingTerm))`** — natural log; tính **một lần** khi persist; lưu key `idf` trong JSONB.
- **`totalSegments`:** tổng số segment trong `canonical_transcript_rows` (sau canonicalize, đã sort timeline); lưu vào `evidence_stats.segment_count` (JSONB) / DTO `evidenceStats.segmentCount`.
- **`segmentsContainingTerm`:** số segment mà `termFrequency` map **có chứa key** của term đó (key tồn tại — bất kể frequency > 0). Đếm trên toàn bộ `canonical_transcript_rows` **sau khi canonicalize** (đã sort theo timeline). Một segment được tính nếu `termFrequency` của nó chứa `term` đó (key tồn tại).
- `termFrequency(term, segment)` = **raw count** trong segment text đã canonical — **không** normalize TF; tokenize theo §2.4.

**Tokenizer consistency:** Tokenizer cho `termFrequency` (persist) và search/score (Java) **phải đồng nhất** — xem §2.4 (`\b\w+\b` + diacritic normalization + lowercase).

**Runtime scoring data source:** `TranscriptEvidenceSearchService` nhận `TranscriptQualityContext` (canonical rows pre-stabilization + `evidenceStats`) từ `ProcessingService` — không query `meeting_analysis_runs` trực tiếp, không HTTP round-trip tại query time.

**Canonical segment mapping (runtime):** Trước khi lookup `termFrequency`, map stabilized segment → canonical row theo §5.3.3. `position_norm` tính trên **canonical row index** trong `canonicalTranscriptRows` (timeline-sorted), không phải stabilized index.

**Runtime score formula (Java — `TranscriptEvidenceSearchService`):**

```text
score = idf(term) × tf(term, segment) × (1 - position_norm × positionNormDecay) × speaker_boost
```

| Component | Source at runtime | Notes |
|-----------|-------------------|-------|
| `idf(term)` | `evidence_stats.idf[term]` | O(1) map lookup; **ln** base (persist time) |
| `tf(term, segment)` | `canonicalRow.termFrequency[term]` | **Raw count** — O(1) map lookup |
| `position_norm` | `canonicalIndex / max(1, totalSegments - 1)` | Index trong canonical array; **bắt đầu 0** |
| `positionNormDecay` | policy `evidence.positionNormDecay` | Default **0.5** |
| `speaker_boost` | policy `evidence.speakerBoost` khi `EVIDENCE_QA_ENABLED=true` | Default policy **1.1**. Chỉ fallback **`1.0`** khi policy không load (`POLICY_LOAD_FALLBACK`) |

- **Không** scan toàn transcript để tính IDF tại query time.
- **Không** dùng `precomputedTfIdfWeight` — đã xóa khỏi schema.

**Dedupe:**

| Field | Rule |
|-------|------|
| `dedupeKey` | `SPEAKER_{speakerLabel}:{startTime}:{endTime}:{textHash}` — ví dụ `SPEAKER_1:42.0:45.5:a3f2b1c9`. `speakerLabel` = speaker id string (e.g. `SPEAKER_1`). `textHash` = **8 ký tự đầu** SHA-256 hex của **normalized text** (§2.4 diacritic normalization + lowercase) |
| Dedupe window | Hai matches cùng `speaker` và `\|startTime_a - startTime_b\| ≤ dedupeWindowSeconds` → giữ score cao hơn |
| Log | `EVIDENCE_QA_DEDUPED` khi remove duplicate |

**Score → verificationStatus (order matters):**

1. Tính `score` theo công thức trên.
2. **Clamp** `score` to `[0.0, 1.0]`.
3. `verificationStatus`: `verified` if `score >= minScore`; `weak` if `score >= minScore * 0.7`; else `unverified`.

**Worked example (Appendix A — 5 segments, query term `hop_dong`):**

Giả sử `evidence_stats`: `segment_count=5`, `idf["hop_dong"]=0.916` (`ln(5/2)`), `positionNormDecay=0.5`, `speakerBoost=1.1` (policy default §5.2), `minScore=0.35`.

| Canon idx | Text (rút gọn) | `termFrequency["hop_dong"]` | `position_norm` | Factor `(1 - pn × 0.5)` | Pre-clamp (×1.1) | Clamped |
|-----------|----------------|----------------------------|-----------------|-------------------------|------------------|---------|
| 0 | "Mở đầu cuộc họp" | 0 | 0.0 | 1.0 | **0.000** | 0.000 |
| 1 | "Hợp đồng dự thảo" | 1 | 0.25 | 0.875 | **0.882** | 0.882 |
| 2 | "Hợp đồng đã ký" | 1 | 0.5 | 0.75 | **0.756** | 0.756 |
| 3 | "Thanh toán đợt một" | 0 | 0.75 | 0.625 | **0.000** | 0.000 |
| 4 | "Hợp đồng phụ lục" | 2 | 1.0 | 0.5 | **1.008** | **1.000** |

Segment idx 4 có score cao nhất → `verified` (≥ 0.35). Golden fixture: `5-segment-golden.json` (plan Slice 4).

**Fallback khi stats missing:** Nếu `meeting_analysis_runs.evidence_stats` là **NULL** hoặc không chứa `idf` cho term đang score, `TranscriptEvidenceSearchService` **không** throw exception.

- `idf(term)` mặc định = **`0.0`** → `score = 0` → match = **`unverified`**.
- Log `EVIDENCE_QA_STATS_MISSING` (`meetingId`, `term`, `reason`) — ví dụ: `evidence_stats_null`, `idf_key_missing`, `term_frequency_missing`.
- Đảm bảo không crash khi backfill chưa chạy hoặc data corrupt; vận hành vẫn trả response hợp lệ.

**Performance guarantee:** Với `term_frequency` + `idf` pre-persisted, mỗi match scoring là O(1) lookup. Mục tiêu **Search P95 < 100ms** (§10.3) khả thi với meeting **10.000 segments** (scan cap `maxScanSegments` vẫn áp dụng khi cần).

- `minScore` đọc từ `transcript-quality-policy.json` → `evidence.minScore` (default 0.35).

**Không persist evidence table.** Kết quả QA gắn vào **`analysis` JSON response** (action-plan + analysis projection):

```json
{
  "evidence": {
    "matches": [
      {
        "verificationStatus": "verified",
        "score": 1.0,
        "snippet": "...",
        "speaker": "SPEAKER_1",
        "startTime": 42.0,
        "endTime": 45.5,
        "dedupeKey": "SPEAKER_1:42.0:45.5:a3f2b1c9"
      }
    ]
  }
}
```

- Field `evidence` additive; clients cũ bỏ qua được.
- FE action plan preview + history: render **verified evidence block** từ `analysis.evidence.matches` (speaker, time range, snippet, scroll-to-transcript).
**Search ranking dual mode (EVIDENCE_QA vs SEARCH_VERIFY):**

| Flags | Search endpoint ranking | `TranscriptEvidenceMatch` fields |
|-------|-------------------------|----------------------------------|
| `EVIDENCE_QA` off | Baseline phrase > token > position (§2.4) | No `score` / `verificationStatus` |
| `EVIDENCE_QA` on, `SEARCH_VERIFY` off | **Legacy ranking unchanged** (phrase > token > position) | May include `score`, `verificationStatus` for FE display — **ranking order not driven by score** |
| Both on | Stricter guards + scan cap (§5.7); ranking still phrase > token > position unless future spec changes | Full Epic 3 fields |

- `GET /transcript/search` giữ shape hiện tại; `EVIDENCE_QA_ENABLED` ảnh hưởng scoring/dedupe cho analysis path; search **list order** chỉ đổi khi `SEARCH_VERIFY` guards thay đổi eligibility, không re-sort by TF-IDF score.

### 5.5 Domain lexicon model

**`domainMode` resolution:**

| Priority | Source | Notes |
|----------|--------|-------|
| 1 | `meeting.metadata.domainMode` | String pack id, e.g. `"legal"`, `"it"` — từ meeting-service metadata |
| 2 | `policy.lexicon.defaultDomainPack` | Default `"general"` |

- **TODO (post-MVP):** user preference override (profile/settings) có thể thay `domainMode` per user — không implement Epic 3.

Khi `DOMAIN_LEXICON_ENABLED`:

- **Domain packs** (JSON) versioned trong `packages/contracts/domain-packs/`.
- **Config endpoint (ai-service):** `GET /api/config/lexicon?domain={domain}` — **owner: ai-service** (glossary logic lives in ai-service). Khác với `GET /api/config/transcript-quality` trên **processing-service** (§5.2).
- **FE fetch URL:** ``${AI_INTERNAL_BASE}/api/config/lexicon?domain={domain}`` — **không** dùng `PROCESSING_API_BASE`. Endpoint public read (CORS allowlist cho FE origin; same pattern as other ai-service config routes).
- Response: terms + `versionHash` + normalization map.
- **Merge priority (single resolved term set):**
  1. **Domain pack** (nếu flag on và pack được chọn)
  2. **DB glossary** (ai-service `glossary_service`)
  3. **FE static fallback** (`itTerms.ts` bundled defaults)

**ai-service `glossary_service.resolve()`:** merge domain pack terms **+** DB glossary — union; **pack wins** on collision (cùng normalized key).

**Collision handling:**

- Khi pack term và DB glossary term collide (same normalized key): **pack term retained**; log `DOMAIN_LEXICON_COLLISION` (`term`, `packSource`, `dbSource`, `domain`).
- Policy `lexicon.disabledTerms[]` — optional denylist; matched terms excluded from resolved set (pack hoặc DB).

**FE loader:**

- Chỉ fetch pack của **meeting hiện tại**: `domainMode` = `meeting.metadata.domainMode` (§5.5), fallback `policy.lexicon.defaultDomainPack`.
- **Cache key:** `domainPack-{domain}-{versionHash}` (localStorage hoặc in-memory module cache).
- Khi `versionHash` thay đổi (config response) → invalidate cache entry → fetch lại.
- Fetch fail → bundled static fallback (`itTerms.ts`); log `DOMAIN_LEXICON_FALLBACK_STATIC`.

**Domain pack extensibility:** Để thêm pack mới:
1. Thêm file JSON vào `packages/contracts/domain-packs/{name}.json`.
2. Cập nhật `supportedDomainPacks` trong `transcript-quality-policy.json`.
3. Không cần code change ngoài CI schema validation (trừ khi pack cần custom normalizer).

Realtime `keyword_matcher` dùng cùng resolved term set khi flag on.

**Domain pack file schema** (`packages/contracts/domain-packs/{name}.json`):

```json
{
  "domain": "legal",
  "version": "1.0.0",
  "versionHash": "a1b2c3d4e5f6...",
  "terms": [
    { "term": "hợp đồng", "normalized": "hop_dong" },
    { "term": "luật sư", "normalized": "luat_su" }
  ]
}
```

- `versionHash` = SHA-256 hex của **toàn bộ nội dung file JSON** với keys sorted (canonical JSON serialization) — dùng cho FE cache invalidation.
- CI: validate schema trong `packages/tooling/config-validation/`; reject packs thiếu `versionHash` hoặc `terms[]`.

### 5.6 Export golden file strategy

**Input fixture (source of truth for goldens):**

- `demoRecordAUDIOMID/processing-service/src/test/resources/fixtures/meeting-golden.json` — meeting sample có transcript rows, metadata (`domainMode`), analysis stub.
- Script `scripts/generate-export-goldens.sh` đọc fixture này (hoặc `MEETING_ID` live) để generate output files.

Golden fixtures cho regression export (Slice 6):

- **Output path:** `demoRecordAUDIOMID/processing-service/src/test/resources/export-golden/transcript-{format}-{mode}.{ext}`
  - Ví dụ: `transcript-txt-readable.txt`, `transcript-csv-raw.csv`, `report-docx-readable.docx`, `action-plan-docx-readable.docx`
- **Comparison:** byte-to-byte với baseline đã **phê duyệt thủ công** (PR review ghi chú “golden approved”).
- **Generation script:** `scripts/generate-export-goldens.sh` — input: `fixtures/meeting-golden.json` (default) hoặc `MEETING_ID`; output: `export-golden/`. Mỗi PR thay đổi export format **phải** chạy script và commit goldens mới.
- **Format change:** intentional output change → update golden files **trong cùng PR** + mô tả trong commit/PR body.
- `EXPORT_VERIFY_ENABLED` preflight: so `rowCount` readable source vs export metadata trước khi stream bytes.

### 5.7 Search performance fallback

Policy fields:

| Field | Default | Meaning |
|-------|---------|---------|
| `search.maxScanSegments` | `2000` | Max segments scanned per query |
| `search.scanPreference` | `"recent"` | How to select segments when `totalSegments > maxScanSegments` |

**`scanPreference` behavior:**

| Value | Behavior |
|-------|----------|
| `"recent"` (default) | Scan **`maxScanSegments` segment gần nhất** theo timeline (`endTime` desc / tail index) |
| `"all"` | Scan toàn bộ transcript (bỏ qua cap) — **chỉ dùng** khi meeting nhỏ hoặc ops override trong policy; có thể chậm |

Khi `totalSegments > maxScanSegments` và `scanPreference = "recent"`:

- Log `SEARCH_QUERY_LIMITED` (`meetingId`, `totalSegments`, `scannedSegments`, `queryHashPrefix`, `scanPreference`).
- Response vẫn trả matches trong phạm vi đã scan; không error — safe degradation.

Full-scan FTS/index deferred to future epic.

**`SEARCH_VERIFY_ENABLED` — stricter guards** (processing-service only):

| Guard | Behavior when flag on |
|-------|----------------------|
| Query length | Sau normalize, `query.length() < search.minQueryLength` → reject, log `TRANSCRIPT_SEARCH_REJECTED` |
| Token length | Token `< search.minTokenLength` → **skip token** trong search (không throw) |
| Result limit | `search.maxLimit` từ policy thay thế hardcoded `MAX_TRANSCRIPT_SEARCH_LIMIT` (50) |
| Scan cap | `maxScanSegments` + `scanPreference` — log `SEARCH_QUERY_LIMITED` khi cap hit |

Khi flag off → giữ hardcoded limits hiện tại (baseline).

---

## 6. Slice Details

### Slice 1 — Baseline audit + contract inventory

- **Goal:** Lock baseline + contract artifacts; inventory file/symbol map.
- **Deliverables:**
  - `packages/contracts/transcript-quality-policy.json`
  - `packages/contracts/default-policy.json` (§5.2)
  - `GET /api/config/transcript-quality` on processing-service (spec §5.2)
  - Schema validation for both; CI drift check
  - CI fixture validation: sample JSONB rows must include `term_frequency`; sample `evidence_stats` must include `idf` map (when test fixtures present)
  - `docs/epic3-baseline-inventory.md` — symbols to modify/refactor (class, method, DTO); endpoint drift (FE vs OpenAPI); TODO items (realtime `finalizeSttSession` hook wiring §5.3, `getTranscript` legacy path drift)
  - `ConfigController` + `Epic3PolicyLoader` + `SecurityConfig.permitAll` for `GET /api/config/transcript-quality` (§5.2)
  - OpenAPI inventory + legacy path deprecation (§11)
- **Flag:** none
- **Tests:** contract schema validation; snapshot policy JSON

### Slice 2 — Transcript quality improvements

- **Goal:** HTTP → Celery persist with `segment_id` + `term_frequency` + `evidence_stats`; cross-service read (§5.3.2); version read (log + raw); backfill repair.
- **Work:**
  - ai-service: `POST /api/internal/.../canonicalize` (runId + idempotency §5.3.1; reuse `build_canonical_transcript_hash()`; Redis in-flight key) + `GET /api/internal/.../transcript-quality` (§5.3.2)
  - Celery `canonicalize_and_persist`: `segment_id` per row (JSONB snake_case); ln-IDF in `evidence_stats`
  - Alembic: `canonical_transcript_rows` + `evidence_stats` + `canonical_transcript_hash` JSONB/VARCHAR
  - processing-service: `AIServiceClient` (snake↔camel); `TranscriptQualityContext` mapping layer; `selectReadableTranscriptSource` calls §5.3.2; §5.3.3 + `mergeStableSpeakerSegments` segmentId carry
  - Trigger points §5.3 only (`finalizeSttSession`, `processMeeting`)
  - `backfill-canonical.py` with `--rebuild-stats` (default on); generate missing `segment_id`
- **Flag:** `TRANSCRIPT_QUALITY_ENABLED`
- **Tests:**
  - HTTP 202 + `taskId`; idempotent skip → `TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP` + 202
  - GET transcript-quality returns DTO; processing-service does not call Celery directly
  - Version mismatch → `TRANSCRIPT_QUALITY_VERSION_MISMATCH` + raw; **no** auto re-enqueue
  - Backfill `--rebuild-stats` produces `segment_id` + `term_frequency` + `evidence_stats.idf`
  - Performance: canonicalize task P95 < 200ms @ 1000 segments (worker-side, §10.3)

### Slice 3 — Domain lexicon integration

- **Goal:** Single domain pack source; FE highlight + STT glossary aligned.
- **Work:**
  - `packages/contracts/domain-packs/*.json` (seed: `general`, `it`, `legal`, `finance`, `healthcare`)
  - Config endpoint + FE loader (`AI_INTERNAL_BASE` §5.5) replacing hardcoded-only path
  - ai-service: merge domain pack into `glossary_service.resolve()`
- **Flag:** `DOMAIN_LEXICON_ENABLED`
- **Tests:**
  - glossary resolve includes domain terms
  - FE highlight uses loaded pack
  - keyword_matcher hits domain term in realtime fixture

### Slice 4 — Evidence QA (verification + deduplication)

- **Goal:** O(1) ln-TF-IDF scoring with §5.3.3 mapping; evidence in analysis JSON; FE verified block.
- **Work:**
  - `TranscriptEvidenceSearchService`: map stabilized → canonical (§5.3.3); `score = idf × tf × (1 - position_norm × positionNormDecay) × speaker_boost`
  - Dedupe: `dedupeKey` + window (§5.4); clamp before `verificationStatus`
  - **Không** tính IDF/TF tại runtime
  - **Fallback:** NULL `evidence_stats` / missing `idf` → score 0, `unverified`, log `EVIDENCE_QA_STATS_MISSING`
  - Golden fixture `5-segment-golden.json` + Java/Python parity tests
  - FE render from `analysis.evidence.matches`
- **Flag:** `EVIDENCE_QA_ENABLED`
- **Tests:**
  - Unit: score formula + tokenizer parity with §2.4; worked example Appendix A
  - `TRANSCRIPT_QUALITY_SEGMENT_MAP_MISSING` when mapping fails
  - `evidence_stats_null` and `idf_key_missing` → no exception

### Slice 5 — Search verification

- **Goal:** Harden search + performance fallback §5.7; shared `TokenizerUtil`.
- **Work:**
  - Refactor search tokenizer to shared `TokenizerUtil` (Java) — parity §2.4
  - Contract tests from policy search section
  - `maxScanSegments` cap + `SEARCH_QUERY_LIMITED` logging
  - Golden fixtures; OpenAPI update
- **Flag:** `SEARCH_VERIFY_ENABLED`
- **Tests:**
  - expand `ProcessingServiceTranscriptSearchTest`
  - >2000 segments → limited scan + log marker
  - Performance: search P95 < 100ms @ 500 segments, limit 20 (§10.3)

### Slice 6 — Export verification & cleanup

- **Goal:** Golden exports + `generate-export-goldens.sh`; preflight verify.
- **Work:**
  - Golden fixtures §5.6; script `scripts/generate-export-goldens.sh`
  - `EXPORT_VERIFY_ENABLED` preflight; OpenAPI §11
- **Flag:** `EXPORT_VERIFY_ENABLED`
- **Tests:**
  - Byte-to-byte golden compare
  - Performance: DOCX export P95 < 500ms (§10.3)

### Slice 7 — Observability + smoke scripts

- **Goal:** Triage transcript/search/export/lexicon issues in prod logs.
- **Work:**
  - Log markers: `TRANSCRIPT_QUALITY_*`, `EVIDENCE_QA_*`, `TRANSCRIPT_SEARCH_*`, `EXPORT_VERIFY_*`, `DOMAIN_LEXICON_*`
  - `scripts/log-bundle.sh` profile `EPIC3`
  - `docs/deploy/production-smoke-checklist.md` Epic 3 section
  - `scripts/test_log_bundle_epic3.sh`
- **Flag:** none
- **Tests:** smoke script on sample log

---

## 7. Observability / Log Markers

Mọi marker dùng structured log (`event=...`). **Không** log full transcript text hoặc full user query.

### 7.1 Mandatory fields per marker

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
| `TRANSCRIPT_QUALITY_ASYNC_FALLBACK` | `meetingId`, `reason` (Celery unavailable) |
| `TRANSCRIPT_QUALITY_FALLBACK_RAW` | `meetingId`, `sourceReason`, `flagEnabled` |
| `POLICY_LOAD_FALLBACK` | `path`, `reason`, `service` |
| `DOMAIN_LEXICON_LOADED` | `domain`, `versionHash`, `termCount` |
| `DOMAIN_LEXICON_COLLISION` | `term`, `packSource`, `dbSource`, `domain` |
| `DOMAIN_LEXICON_FALLBACK_STATIC` | `domain`, `reason` |
| `EVIDENCE_QA_VERIFIED` | `meetingId`, `matchCount`, `avgScore`, `minScore` |
| `EVIDENCE_QA_WEAK` | `meetingId`, `matchCount`, `avgScore` |
| `EVIDENCE_QA_DEDUPED` | `meetingId`, `removedCount`, `dedupeWindowSeconds` |
| `EVIDENCE_QA_STATS_MISSING` | `meetingId`, `term`, `reason` |
| `TRANSCRIPT_SEARCH_REQUEST` | `meetingId`, `queryHashPrefix`, `resultCount` (existing) |
| `TRANSCRIPT_SEARCH_REJECTED` | `meetingId`, `reason`, `queryLength` |
| `SEARCH_QUERY_LIMITED` | `meetingId`, `totalSegments`, `scannedSegments`, `queryHashPrefix`, `scanPreference` |
| `EXPORT_VERIFY_STARTED` | `meetingId`, `format`, `mode` |
| `EXPORT_VERIFY_FAILED` | `meetingId`, `format`, `mode`, `errorCode` |
| `EXPORT_VERIFY_COMPLETED` | `meetingId`, `format`, `mode`, `byteLength`, `rowCount` |
| `BACKFILL_PROGRESS` | `processedCount`, `successCount`, `failureCount`, `batchSize` (optional: `workerId` when `--concurrency > 1`) |

### 7.2 Additional debug markers (optional, staging)

| Marker | When |
|--------|------|
| `TRANSCRIPT_QUALITY_DISPLAY_MERGE` | FE merge applied (debug) |

---

## 8. Monitoring & Alerts

Metrics derived từ log markers / counters (Prometheus hoặc log-based metrics tùy infra):

| Alert | Condition | Window | Severity |
|-------|-----------|--------|----------|
| `Epic3CanonicalPersistFailureHigh` | `canonical_persist_failure_rate` > **5%** | 10 phút | P1 |
| `Epic3CanonicalPersistFailedCount` | `TRANSCRIPT_QUALITY_PERSIST_FAILED` count > **10** | 15 phút | P1 |
| `Epic3EvidenceWeakRatioHigh` | `evidence_weak_ratio` > **50%** | 30 phút | P2 |
| `Epic3ExportFailureHigh` | `export_failure_rate` > **2%** | 15 phút | P1 |
| `Epic3LexiconCollisionHigh` | `DOMAIN_LEXICON_COLLISION` count > **100** | 1 giờ | P3 (informational) |

**Metric definitions:**

- `canonical_persist_failure_rate` = `TRANSCRIPT_QUALITY_PERSIST_FAILED` / (`TRANSCRIPT_QUALITY_CANONICAL_PERSISTED` + `TRANSCRIPT_QUALITY_PERSIST_FAILED`)
- `canonical_persist_duration_ms` — P50/P95/P99 histogram (Celery worker)
- `evidence_weak_ratio` = weak matches / total matches từ `EVIDENCE_QA_WEAK` + `EVIDENCE_QA_VERIFIED`
- `export_failure_rate` = `EXPORT_VERIFY_FAILED` / (`EXPORT_VERIFY_COMPLETED` + `EXPORT_VERIFY_FAILED`)

Runbook: disable Epic 3 flag tương ứng → investigate log bundle `EPIC3` → repair script nếu sidecar corrupt (§11).

---

## 9. Data Migration

### 9.1 Schema change

- **Migration:** Alembic `008_meeting_analysis_runs_canonical_rows.py` (tên tùy implement) thêm **chỉ**:
  - `meeting_analysis_runs.canonical_transcript_rows` — **JSONB**, nullable (rows: snake_case `segment_id`, `start_time`, `end_time`, `term_frequency`)
  - `meeting_analysis_runs.evidence_stats` — **JSONB**, nullable (`idf` map + `segment_count`, `computed_at`, `canonical_version` — snake_case)
- **Columns đã có (migration 006 — không thêm lại trong 008):**
  - `meeting_analysis_runs.canonical_transcript_hash` — **VARCHAR(64)**, nullable — idempotency key (§5.3.1); index `ix_meeting_analysis_runs_canonical_transcript_hash`
  - `meeting_analysis_runs.canonical_transcript_version` — Epic 3 ghi `policy.transcript.canonicalVersion` khi persist
- **Không auto-backfill** trong migration — meetings cũ giữ `NULL` cho đến khi chạy script thủ công hoặc re-process.

### 9.1.1 Index optimization

| Index | Status | Purpose |
|-------|--------|---------|
| `ix_meeting_analysis_runs_meeting_id` | **Exists** (migration 006) | Filter by meeting |
| `ix_meeting_analysis_runs_status` | **Exists** | Filter by status |
| `ix_meeting_analysis_runs_meeting_status_updated` | **Exists** — `(meeting_id, status, updated_at)` | Latest run lookup; satisfies `meeting_id + status` query pattern |
| `idx_meeting_analysis_runs_meeting_id_status` | **Alias / verify in migration 008** | Nếu composite `(meeting_id, status)` chưa cover đủ planner, add explicit index; else document reuse of `ix_meeting_analysis_runs_meeting_status_updated` |
| GIN on `canonical_transcript_rows` | **Not created in MVP migration** | Composite `(meeting_id, status, updated_at)` đủ cho query lấy run mới nhất; không query JSONB path trong MVP. **Decision:** skip GIN trong Alembic 008. Nếu `canonical_transcript_rows` path query trở nên frequent → follow-up migration thêm GIN. |

Query pattern (runId resolution §5.3.1): `SELECT ... FROM meeting_analysis_runs WHERE meeting_id = ? ORDER BY updated_at DESC LIMIT 1` (any status).

### 9.1.2 JSONB row schema

**Canonical row (`canonical_transcript_rows[]`) — required fields (snake_case JSONB):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `segment_id` | UUID string | **yes** | Stable key for §5.3.3 mapping; HTTP DTO alias `segmentId` (camelCase) |
| `text` | string | yes | Canonical segment text |
| `speaker` | string | yes | e.g. `SPEAKER_1` |
| `start_time` | number | yes | Seconds; DTO `startTime` |
| `end_time` | number | yes | Seconds; DTO `endTime` |
| `term_frequency` | object | yes when evidence path | Map normalized term → raw count; DTO `termFrequency` |

```json
{
  "segment_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "text": "Hợp đồng luật sư đã ký",
  "speaker": "SPEAKER_1",
  "start_time": 12.5,
  "end_time": 15.2,
  "term_frequency": {
    "hop_dong": 1,
    "luat_su": 1
  }
}
```

**DTO mapping:** ai-service `GET /api/internal/.../transcript-quality` serializes camelCase; Java `AIServiceClient` maps to/from snake_case JSONB on persist.

**`evidence_stats` — required fields (snake_case JSONB; HTTP DTO camelCase):**

| JSONB field | DTO field | Type | Required | Notes |
|-------------|-----------|------|----------|-------|
| `idf` | `idf` | object | yes | Term → ln-IDF float |
| `segment_count` | `segmentCount` | integer | yes | Equals canonical row count |
| `computed_at` | `computedAt` | ISO-8601 string | yes | Persist timestamp |
| `canonical_version` | `canonicalVersion` | string | yes | Matches `policy.transcript.canonicalVersion` |

```json
{
  "idf": { "hop_dong": 0.693, "luat_su": 0.405 },
  "segment_count": 42,
  "computed_at": "2026-06-22T10:00:00Z",
  "canonical_version": "canonical-transcript-v2"
}
```

**CI:** `packages/tooling/config-validation/` validate fixture JSONB samples against schema above; reject rows missing `segment_id` or `term_frequency` when evidence fixtures present.

### 9.2 Backfill & repair scripts

| Script | Purpose |
|--------|---------|
| `demoRecordAUDIOMID/ai-service/app/scripts/backfill_canonical.py` (extend) | Backfill `canonical_transcript_rows` + **`evidence_stats`** từ raw transcript |
| `scripts/backfill-canonical.py` (ops wrapper) | `--meeting-id`, `--dry-run`, `--batch-size` (default **100**), `--concurrency` (default **1**), **`--rebuild-stats`** (default **on**) |

**Concurrency & batch:** `scripts/backfill-canonical.py` hỗ trợ `--batch-size` (mặc định 100) và `--concurrency` (mặc định 1). Khi `--concurrency > 1`, mỗi worker xử lý **một meeting độc lập** — đảm bảo không xung đột ghi (mỗi meeting chỉ một worker cập nhật).

**Logging:** Log `BACKFILL_PROGRESS` định kỳ (mỗi 100 meetings) với `processedCount`, `successCount`, `failureCount`, `batchSize`. Khi `--concurrency > 1`, mỗi worker log **độc lập** — thêm `workerId` để tránh nhầm lẫn; mỗi worker vẫn log định kỳ (ví dụ mỗi 100 meetings) để tránh log spam.

**Bắt buộc khi backfill/repair:** Ngoài `canonicalize_segments`, script **phải**:

1. Gán `segment_id` (UUID) cho mỗi row nếu thiếu
2. Tái tính `term_frequency` map cho **từng** segment row trong `canonical_transcript_rows`
3. Tái tính `idf` map trong `evidence_stats` (ln base)

Ghi đè cả hai field. Nếu chỉ canonicalize mà không rebuild stats → **Slice 4 Evidence QA bị hỏng** (Java lookup `idf`/`termFrequency` miss).

- Flag `--rebuild-stats`: mặc định **enabled**; tắt chỉ cho debug (không dùng prod).
- **Pre-prod gate:** Chạy `scripts/backfill-canonical.py --dry-run` trên staging; xác nhận output có `evidence_stats.idf` và mỗi row có `termFrequency` trước khi enable `TRANSCRIPT_QUALITY_ENABLED` ở production (§12).

**Chạy thủ công** khi enable flag staging/prod lần đầu, policy version bump, hoặc sau incident.

### 9.3 Rollback dữ liệu

1. **Flag off (`TRANSCRIPT_QUALITY_ENABLED=false`):** read path **fallback về logic cũ** — không đọc `meeting_analysis_runs.canonical_transcript_rows` / `evidence_stats`. Thứ tự: ai persisted canonical → `job_state` raw → ai persisted transcript (giữ behavior hiện tại §5.3).
2. **Legacy `transcripts.canonical_transcript_rows`:** vẫn được hỗ trợ khi flag off (sidecar trên bảng `transcripts`); **không xóa** trong Epic 3. Khi flag on, ưu tiên `meeting_analysis_runs` JSONB.
3. **Corrupt sidecar:** chạy repair script — `canonicalize_segments` + rebuild `term_frequency` / `idf` + ghi đè JSONB.
4. **Emergency:** `UPDATE meeting_analysis_runs SET canonical_transcript_rows = NULL, evidence_stats = NULL WHERE ...` (scoped by `meeting_id`) + re-backfill `--rebuild-stats`.

---

## 10. Test Plan

### Unit / service

- Java: `TranscriptEvidenceSearchServiceTest`, `ProcessingServiceTranscriptSearchTest`, `MeetingActionPlanBuilderTest`, report generator tests
- Python: `test_transcript_canonicalizer.py`, glossary domain pack tests
- FE: `transcript.test.ts`, `MeetingHistoryScene.test.tsx`, `api.test.ts`

### Integration

- **E2E (post–Slice 6):** `Epic3EndToEndIT` @ profile `epic3-e2e` — upload → finalize → search → `analysis.evidence` → DOCX export (see plan Slice E2E)
- Auth: cross-user transcript/search/export denied
- Flag off: identical baseline responses (snapshot)

### Regression suite (required per slice)

- Realtime mic/tab recording still produces transcript segments
- Upload transcript display unchanged when `TRANSCRIPT_QUALITY_ENABLED=false`
- Existing export downloads still work
- `POLICY_LOAD_FALLBACK` does not crash services; defaults applied

### Performance & Load (staging gate before prod flag enable)

| Operation | Threshold | Fixture | Notes |
|-----------|-----------|---------|-------|
| Canonical persist (Celery worker) | **P95 < 200ms** | 1000 segments | Measure `canonical_persist_duration_ms`; finalize HTTP path không đo (async) |
| Transcript search | **P95 < 100ms** | 500 segments, limit 20 | O(1) `idf` + `termFrequency` lookup từ `evidence_stats` + segment rows (§5.4); **không** tính IDF runtime; khả thi đến ~10k segments với scan cap |
| Export DOCX generation | **P95 < 500ms** | Standard meeting fixture | Report or action-plan DOCX |

Fail performance gate → investigate before enabling flags in production. Run via JMH micro-benchmark (Java) hoặc `pytest`/`locust` profile trong CI nightly (không block PR merge MVP).

---

## 11. OpenAPI Update Plan

File: `packages/contracts/processing-api.yaml`

| Endpoint | Status | Action |
|----------|--------|--------|
| `GET /processing/{meetingId}/transcript` | Implemented | **Document** as canonical read path |
| `GET /processing/transcript/{meetingId}` | Legacy | Mark **`deprecated: true`** in OpenAPI; description points clients to `GET /processing/{meetingId}/transcript` |
| `GET /processing/{meetingId}/transcript/search` | Implemented | **Update** response schema: `TranscriptSearchResponse`, `TranscriptEvidenceMatch` (+ optional `verificationStatus`, `score` when Epic 3) |
| `GET /processing/{meetingId}/action-plan` | Implemented | **Add** path + schema: `ActionPlanResponse` with `evidence.matches[]` |
| `GET /processing/{meetingId}/action-plan/export` | Implemented | **Add** path; `format=docx`; binary response |
| `GET /processing/{meetingId}/transcript/export` | Implemented | **Document** `format`, `mode=readable\|raw` query params |
| `GET /processing/{meetingId}/report` | Implemented | **Document** `format=docx` |
| `GET /api/config/lexicon` | New (Slice 3) | **ai-service** — `domain` query; response `LexiconConfig` with `versionHash` (§5.5) |
| `GET /api/config/transcript-quality` | New (Slice 1/2) | **processing-service** — serves `transcript-quality-policy.json` (§5.2) |
| `GET /api/internal/meetings/{meetingId}/transcript-quality` | New (Slice 2) | ai-service internal read DTO (§5.3.2) — document in service README, not public OpenAPI |
| `POST /api/internal/meetings/{meetingId}/canonicalize` | New (Slice 2) | ai-service internal enqueue — document in service README, not public OpenAPI |

**Schemas to add/update:**

- `TranscriptEvidenceMatch` — thêm `verificationStatus`, `score`, `dedupeKey` là **optional** (additive, không break FE cũ). OpenAPI: `additionalProperties: false`; field Epic 3 có extension `x-epic3: true`.
- `EvidenceBlock` — `{ matches: TranscriptEvidenceMatch[] }`
- `ActionPlanResponse` — embed `evidence: EvidenceBlock`
- `LexiconConfig` — `domain`, `versionHash`, `terms[]`

CI: regenerate/check OpenAPI client if applicable; contract test against live controller responses.

---

## 12. Rollout Plan

1. Merge Epic 3 slices behind flags (default off).
2. Staging: enable `TRANSCRIPT_QUALITY_ENABLED` → smoke readable transcript parity.
3. **Pre-prod backfill check:** `scripts/backfill-canonical.py --dry-run` trên staging — verify `evidence_stats.idf` + per-row `termFrequency` trước production flag enable.
4. Enable `SEARCH_VERIFY_ENABLED` + `EVIDENCE_QA_ENABLED` → verify action plan citations.
5. Enable `DOMAIN_LEXICON_ENABLED` for one domain pack (e.g. `it`).
6. Enable `EXPORT_VERIFY_ENABLED` → run export golden tests against staging data.
7. Production: gradual flag enable per slice; monitor `EPIC3` log bundle.

Rollback: set any Epic 3 flag to `false` → instant baseline path (no deploy revert required). Data repair via §9.3 if needed.

---

## 13. Definition of Done

- [ ] `transcript-quality-policy.json` + `default-policy.json` (copy/sync from policy) in CI contract-check; `POLICY_LOAD_FALLBACK` tested
- [ ] `scripts/sync-default-policy.sh` → `transcriptQualityDefaults.json` + `fallback-policy.ts`; CI prebuild drift check
- [ ] `docs/epic3-baseline-inventory.md` — symbols, endpoint drift, TODO (realtime hook, legacy `getTranscript` path)
- [ ] `GET /api/config/transcript-quality` on processing-service; `ConfigController` + `Epic3PolicyLoader` + `SecurityConfig.permitAll` (§5.2)
- [ ] FE `getTranscriptQualityPolicy()` via `PROCESSING_API_BASE`; lexicon via `AI_INTERNAL_BASE` (§5.5)
- [ ] `POST /api/internal/meetings/{meetingId}/canonicalize` → 202 `{ taskId }`; runId any-status + deferred retry (§5.3.1); `TRANSCRIPT_QUALITY_SKIP_NO_RUN`
- [ ] `build_canonical_transcript_hash()` reuse; Redis in-flight key `canonicalize:{meetingId}:{runIdOrNone}:{hash}` (`runIdOrNone` = run id hoặc `none`) TTL 10m; `TRANSCRIPT_QUALITY_IDEMPOTENT_SKIP` with `reason` (`persisted` \| `in_flight`)
- [ ] `GET /api/internal/meetings/{meetingId}/transcript-quality` DTO camelCase; `ready` = rows + stats + hash all non-null (§5.3.2)
- [ ] JSONB snake_case (`start_time`, `end_time`, `segment_id`, `term_frequency`); `AIServiceClient` mapping; `TranscriptQualityContext` pre-stabilization
- [ ] `TRANSCRIPT_QUALITY_NOT_READY` (`celery_pending`) vs `TRANSCRIPT_QUALITY_VERSION_MISMATCH` distinct fallbacks
- [ ] Celery `app.tasks.canonicalize_and_persist`; retry `max_retries=3`
- [ ] §5.3.3 stabilization→canonical mapping; `mergeStableSpeakerSegments` keeps first `segmentId`; `TRANSCRIPT_QUALITY_MERGE_NO_SEGMENT_ID`
- [ ] Trigger points only: `finalizeSttSession()` + `processMeeting()` (§5.3)
- [ ] Version mismatch: log + raw only; repair via `backfill-canonical.py --rebuild-stats`
- [ ] Shared tokenizer §2.4 (`\b\w+\b`) in Python + Java `TokenizerUtil`; unit tests
- [ ] Scoring formula §5.4 (`speakerBoost=1.1`, clamp, dedupeKey); `5-segment-golden.json` parity (Appendix A)
- [ ] Search dual-mode: `EVIDENCE_QA` on + `SEARCH_VERIFY` off → legacy ranking (§5.4)
- [ ] `EVIDENCE_QA_STATS_MISSING` fallback; no crash on NULL `evidence_stats`
- [ ] `meeting-golden.json` + `generate-export-goldens.sh`
- [ ] `scanPreference` + diacritic normalization §2.4
- [ ] E2E: `Epic3EndToEndIT` + profile `epic3-e2e` (mock ai-service 202 + seed JSONB)
- [ ] All 5 Epic 3 feature flags wired (`Epic3FeatureFlags` @ConfigurationProperties); default false; matrix §5.1
- [ ] `DOMAIN_LEXICON_COLLISION` logging; `disabledTerms` policy support
- [ ] `SEARCH_QUERY_LIMITED` for >2000 segments
- [ ] Performance gates §10.3 met in staging
- [ ] Policy reload: restart documented; no hot-reload required MVP
- [ ] JSONB schema §9.1.2 validated in CI fixtures (snake_case)
- [ ] Domain lexicon merge §5.5 + ai-service lexicon endpoint + ≥2 domain packs
- [ ] `analysis.evidence.matches` populated when `EVIDENCE_QA_ENABLED`; FE verified evidence block
- [ ] Search contract tests + OpenAPI §11 updated
- [ ] Export golden fixtures §5.6 + OpenAPI §11 updated
- [ ] Monitoring alerts §8 configured in staging
- [ ] E2E test green (upload → search → evidence → DOCX export)
- [ ] `log-bundle.sh --grep EPIC3` + production smoke checklist; all §7.1 markers including new skip/merge/idempotent `reason`
- [ ] Backfill/repair scripts documented and smoke-tested; `segment_id` backfill
- [ ] No regression in Epic 1 realtime + Epic 2 upload/error paths
- [ ] PR merged to `main` with per-slice commits recommended

---

## 14. Implementation file map

Bảng dưới map **spec section → file cụ thể**. File đánh dấu **(new)** chưa tồn tại — tạo trong slice tương ứng.

### 14.1 Contracts & CI (Slice 1)

| Artifact | Path | Action |
|----------|------|--------|
| Policy contract | `packages/contracts/transcript-quality-policy.json` | exists — baseline |
| Default fallback | `packages/contracts/default-policy.json` | **(new)** copy/sync từ policy |
| Schema | `packages/contracts/config.schema.json` | extend validate policy + default |
| Sync script | `scripts/sync-default-policy.sh` | **(new)** |
| FE bundled defaults | `FE-Audiomind/src/config/transcriptQualityDefaults.json` | **(new)** generated |
| FE hard fallback | `FE-Audiomind/src/config/fallback-policy.ts` | **(new)** generated |
| CI validation | `packages/tooling/config-validation/` | extend JSONB fixtures §9.1.2 |
| Inventory | `docs/epic3-baseline-inventory.md` | **(new)** |

### 14.2 processing-service (Slice 1–2, 4–6)

| Component | Path | Slice | Notes |
|-----------|------|-------|-------|
| Config endpoint | `.../controller/ConfigController.java` | 1 | **(new)** `GET /api/config/transcript-quality` |
| Policy loader | `.../config/Epic3PolicyLoader.java` | 1 | **(new)** |
| Feature flags | `.../config/Epic3FeatureFlags.java` | 1–2 | **(new)** mirror `Epic2FeatureFlags.java` |
| Security | `.../config/SecurityConfig.java` | 1 | `permitAll` GET config |
| AI client | `.../client/AIServiceClient.java` | 2 | add `requestCanonicalize`, `getTranscriptQuality` |
| Quality context | `.../service/TranscriptQualityContext.java` or extend `TranscriptPayload` | 2 | **(new)** pre-stabilization rows |
| Read path | `.../service/ProcessingService.java` | 2 | `selectReadableTranscriptSource()` ~L3085; `processMeeting()` hook ~L327 |
| Realtime hook | `.../interfaces/websocket/MeetingWebSocketHandler.java` | 2 | `finalizeSttSession()` ~L1280 / ~L1203 |
| Evidence search | `.../service/TranscriptEvidenceSearchService.java` | 4–5 | scoring §5.4; `TokenizerUtil` |
| Tokenizer | `.../util/TokenizerUtil.java` | 2/5 | **(new)** shared `\b\w+\b` |
| Action plan | `.../service/MeetingActionPlanBuilder.java` | 4 | `minScore`, dedupe |
| Export | `.../service/report/*` | 6 | verified evidence block |
| Tests | `ProcessingServiceTest.java`, `TranscriptEvidenceSearchService` tests, `Epic3EndToEndIT` | 2–6 | golden `5-segment-golden.json` |

### 14.3 ai-service (Slice 2–3)

| Component | Path | Slice | Notes |
|-----------|------|-------|-------|
| Canonicalizer | `app/services/transcript_canonicalizer.py` | 2 | reuse `build_canonical_transcript_hash()`, `canonicalize_segments()` |
| Internal routes | `app/routers/internal_meetings.py` or extend `main.py` | 2 | **(new)** canonicalize + transcript-quality |
| Celery tasks | `app/tasks.py` | 2 | `canonicalize_and_persist`, `canonicalize_deferred_retry` |
| Redis idempotency | reuse `app/job_status_store.py` `_get_client()` | 2 | in-flight keys §5.3.1 |
| Tokenizer | `app/utils/tokenizer.py` | 2 | **(new)** |
| Migration | `alembic/versions/008_*.py` | 2 | JSONB columns only §9.1 |
| Backfill | `app/scripts/backfill_canonical.py` | 2 | `--rebuild-stats`, `segment_id` |
| Lexicon | `app/services/glossary_service.py` | 3 | domain packs §5.5 |
| Lexicon config route | `app/main.py` or router | 3 | `GET /api/config/lexicon` |

### 14.4 Frontend (Slice 1–4)

| Component | Path | Slice |
|-----------|------|-------|
| Policy load | `FE-Audiomind/src/services/config.ts` | 1 |
| Transcript utils | `FE-Audiomind/src/utils/transcript.ts` | 2–3 |
| Display | `FE-Audiomind/src/components/TranscriptDisplay.tsx` | 2 |
| Analysis panel | `FE-Audiomind/src/components/AnalysisStatusPanel.tsx` | 4 |
| API | `FE-Audiomind/src/services/api.ts` | 1 | migrate `getTranscript` path §11 |

### 14.5 Environment variables (all services)

| Variable | Service | Default | Flag |
|----------|---------|---------|------|
| `EPIC3_TRANSCRIPT_QUALITY_ENABLED` | processing + ai | `false` | `TRANSCRIPT_QUALITY_ENABLED` |
| `EPIC3_DOMAIN_LEXICON_ENABLED` | processing + ai + FE | `false` | `DOMAIN_LEXICON_ENABLED` |
| `EPIC3_EVIDENCE_QA_ENABLED` | processing | `false` | `EVIDENCE_QA_ENABLED` |
| `EPIC3_SEARCH_VERIFY_ENABLED` | processing | `false` | `SEARCH_VERIFY_ENABLED` |
| `EPIC3_EXPORT_VERIFY_ENABLED` | processing | `false` | `EXPORT_VERIFY_ENABLED` |

Java: `epic3.transcript-quality-enabled` via `@ConfigurationProperties(prefix = "epic3")`. Python: mirror trong `app/config.py`. Không đổi tên env giữa services.
