# Epic 3 — Baseline Inventory (Slice 1)

Branch: `feat/transcript-evidence-export-quality`  
Spec/plan: rev 13 — `docs/7t-transcript-evidence-export-quality-spec.md`

Inventory này liệt kê symbols hiện có cần modify ở các slice sau, endpoint drift, và hook points đã khóa trong spec §5.3.

---

## 1. Symbols to modify (by slice)

### Slice 1 (this slice) — DONE targets

| Symbol | Path | Status |
|--------|------|--------|
| `ConfigController` | `processing-service/.../controller/ConfigController.java` | **Added** — `GET /api/config/transcript-quality` |
| `Epic3PolicyLoader` | `processing-service/.../config/Epic3PolicyLoader.java` | **Added** — schema validation via `TranscriptQualityPolicyValidator` |
| `TranscriptQualityPolicyValidator` | `processing-service/.../config/TranscriptQualityPolicyValidator.java` | **Added** |
| `Epic3FeatureFlags` | `processing-service/.../config/Epic3FeatureFlags.java` | **Added** |
| `Epic3ApiPaths` | `processing-service/.../config/Epic3ApiPaths.java` | **Added** |
| `SecurityConfig` | `processing-service/.../config/SecurityConfig.java` | **Updated** — `permitAll` config path |
| `getTranscriptQualityPolicy` | `FE-Audiomind/src/services/configService.ts` | **Added** |
| Policy contracts | `packages/contracts/transcript-quality-policy.json`, `default-policy.json` | **Present** |
| Sync script | `scripts/sync-default-policy.sh` | **Added** — primary from `transcript-quality-policy.json`, default from `default-policy.json` |
| CI drift | `packages/tooling/config-validation/validate-policy.mjs` | Validates contracts + FE bundle + processing resources |

### Slice 2 — Transcript quality persist

| Symbol | Path | Action |
|--------|------|--------|
| `build_canonical_transcript_hash()` | `ai-service/app/services/transcript_canonicalizer.py` | Reuse for idempotency |
| `canonicalize_segments()` | `ai-service/app/services/transcript_canonicalizer.py` | Celery task input |
| `canonicalize_and_persist` | `ai-service/app/tasks.py` | **New** Celery task |
| `canonicalize_deferred_retry` | `ai-service/app/tasks.py` | **New** deferred retry |
| Internal routes | `ai-service` router | `POST .../canonicalize`, `GET .../transcript-quality` |
| `AIServiceClient` | `processing-service/.../client/AIServiceClient.java` | `requestCanonicalize`, `getTranscriptQuality` |
| `selectReadableTranscriptSource()` | `processing-service/.../service/ProcessingService.java` ~L3085 | HTTP read when flag on |
| `processMeeting()` | `processing-service/.../service/ProcessingService.java` ~L327 | Upload hook |
| `finalizeSttSession()` | `processing-service/.../interfaces/websocket/MeetingWebSocketHandler.java` ~L1280, ~L1203 | Realtime hook |
| `TranscriptQualityContext` | processing-service | **New** DTO/context |
| `MeetingAnalysisRun` model | `ai-service/app/models.py` | Add JSONB columns (migration 008) |
| `backfill_canonical.py` | `ai-service/app/scripts/backfill_canonical.py` | Extend for `meeting_analysis_runs` |

### Slice 3 — Domain lexicon

| Symbol | Path | Action |
|--------|------|--------|
| `glossary_service.py` | `ai-service/app/services/glossary_service.py` | Domain pack merge |
| `keyword_matcher.py` | `ai-service/app/services/keyword_matcher.py` | Lexicon hints |
| FE lexicon cache | `FE-Audiomind/src/utils/transcript.ts` | Fetch `${AI_INTERNAL_BASE}/api/config/lexicon` |

### Slice 4 — Evidence QA

| Symbol | Path | Action |
|--------|------|--------|
| `TranscriptEvidenceSearchService` | `processing-service/.../service/TranscriptEvidenceSearchService.java` | TF-IDF scoring §5.4 |
| `MeetingActionPlanBuilder` | processing-service | `minScore`, dedupe, `verificationStatus` |
| `stabilizeReadableTranscriptRows()` | `ProcessingService.java` | §5.3.3 mapping |

### Slice 5 — Search verify

| Symbol | Path | Action |
|--------|------|--------|
| `TranscriptEvidenceSearchService` | processing-service | `TokenizerUtil`, scan cap |
| `GET /processing/{meetingId}/transcript/search` | `ProcessingController` | Contract tests |

### Slice 6 — Export verify

| Symbol | Path | Action |
|--------|------|--------|
| `service/report/*` | processing-service | Verified evidence in DOCX |
| Export controllers | `ProcessingController` | Preflight + golden fixtures |

---

## 2. Endpoint drift (FE vs OpenAPI)

| Endpoint | FE usage | OpenAPI / REST canonical | Drift |
|----------|----------|--------------------------|-------|
| Transcript read | `GET ${API_BASE}/processing/transcript/{meetingId}` (`api.ts` `getTranscript`) | `GET /processing/{meetingId}/transcript` | **Legacy path in FE** — migrate Slice 1+ or defer with tech debt note |
| Transcript search | `searchMeetingTranscriptEvidence` | Documented partial | OpenAPI gap noted in spec §11 |
| Action plan | `getMeetingActionPlan` | Partial | OpenAPI gap |
| Upload config | `${MEETING_API_BASE}/api/config/upload` | meeting-service | OK (Epic 2) |
| Transcript quality config | `${PROCESSING_API_BASE}/api/config/transcript-quality` | **New Slice 1** | OK |

---

## 3. Hook points (Slice 2 wiring — spec §5.3)

| Location | File | Line (approx) | Guard |
|----------|------|---------------|-------|
| Realtime finalize success | `MeetingWebSocketHandler.java` | ~L1280 after `REALTIME_FINALIZE_COMPLETE` | `Epic3FeatureFlags.transcriptQualityEnabled` |
| Realtime skip-low-value path | `MeetingWebSocketHandler.java` | ~L1203 | same |
| Upload/batch | `ProcessingService.processMeeting()` | ~L327 after `processAudio` success | same |

Call pattern: fire-and-forget `aiServiceClient.requestCanonicalize(meetingId, null, traceId)` — async, log `TRANSCRIPT_QUALITY_CANONICALIZE_ENQUEUED`.

---

## 4. Legacy storage note

| Store | Table | Epic 3 target |
|-------|-------|---------------|
| Legacy canonical sidecar | `transcripts.canonical_transcript_rows` | Keep when flag off |
| Epic 3 hot path | `meeting_analysis_runs.canonical_transcript_rows` + `evidence_stats` | Slice 2 migration 008 |

`canonical_transcript_hash` already on `meeting_analysis_runs` (migration 006).

---

## 5. OpenAPI gaps (from audit)

Missing or under-documented in `packages/contracts/processing-api.yaml`:

- `GET /processing/{meetingId}/transcript/search`
- `GET /processing/{meetingId}/action-plan`
- `GET /processing/{meetingId}/action-plan/export`
- Deprecation marker for `GET /processing/transcript/{meetingId}`

Slice 1 adds processing-service `GET /api/config/transcript-quality` (document in spec §11; public OpenAPI update can follow in Slice 2).

---

## 6. Feature flags (default `false`)

| Flag | Java property (`epic3.*`) | Env |
|------|---------------------------|-----|
| `TRANSCRIPT_QUALITY_ENABLED` | `transcript-quality-enabled` | `EPIC3_TRANSCRIPT_QUALITY_ENABLED` |
| `DOMAIN_LEXICON_ENABLED` | `domain-lexicon-enabled` | `EPIC3_DOMAIN_LEXICON_ENABLED` |
| `EVIDENCE_QA_ENABLED` | `evidence-qa-enabled` | `EPIC3_EVIDENCE_QA_ENABLED` |
| `SEARCH_VERIFY_ENABLED` | `search-verify-enabled` | `EPIC3_SEARCH_VERIFY_ENABLED` |
| `EXPORT_VERIFY_ENABLED` | `export-verify-enabled` | `EPIC3_EXPORT_VERIFY_ENABLED` |

---

*Generated for Epic 3 Slice 1 — update as slices land.*
