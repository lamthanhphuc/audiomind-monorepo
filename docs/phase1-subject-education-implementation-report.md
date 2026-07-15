# Phase 1 — Implementation report

**Branch:** `feature/phase1-subject-education`  
**Base:** `origin/main` @ `d77a030`  
**Started:** 2026-07-15  
**Status:** In progress (Steps 0–3 complete)

## A. Git cleanup

| Item | Result |
|------|--------|
| Stage A | Completed — audit report only, no deletions/tags |
| Stage B | **Not performed** — awaiting user approval |
| Feature branch | `feature/phase1-subject-education` created from `main` |

See [branch-cleanup-report.md](./branch-cleanup-report.md).

## B. Step 0 — Source verification

### grpc_stt_service reachability (locked)

| Finding | Detail |
|---------|--------|
| Production start | `main.py` lifespan starts gRPC when `_get_stt_adapter()` returns adapter (requires `deepgram_api_key`) |
| Primary browser realtime | WebSocket → `stt_session_actor` → `DeepgramSTTAdapter._resolve_segment_id` (stable meeting-start IDs) |
| gRPC `StreamAudio` | **Reachable** when gRPC server runs; was `uuid4()` — now canonicalized via `segment_identity.py` |
| **Decision** | Evidence guarantee for gRPC stream path included in same contract as adapter path |

### Plan deviations

| Area | Deviation | Reason |
|------|-----------|--------|
| Deepgram missing speaker | ID uses `speaker_unknown` (not `speaker_1`) | Plan §5.3 test vectors; updated `test_deepgram_stt_adapter` |
| Batch transcript format | `format_aligned_transcript_for_analysis` adds `[SEGMENT_ID=…]` markers | Plan §5.4; cache tests updated to match formatted text |

## C. Commits landed

| Commit | Message | Scope |
|--------|---------|-------|
| `0fb4cbc` | `docs: add phase 1 plan and git stage A audit report` | Plan + branch audit + report stub |
| `b2a154a` | `feat(ai): add segment identity source of truth` | `segment_identity.py`, stt_adapter, grpc, canonical persist |
| `c948106` | `feat(ai): domain-aware analysis cache identity` | `analysis_versioning.py`, cache lookup by `idempotency_key`, pipeline/main wire-up |

## D. Segment identity (Step 2)

- **New:** `demoRecordAUDIOMID/ai-service/app/services/segment_identity.py`
- **Delegated:** `stt_adapter._resolve_segment_id`, `main._build_segment_id`, `canonical_persist_service.assign_segment_ids`, `grpc_stt_service` partial/final events
- **Batch:** `pipeline.py` assigns stable IDs before analysis; transcript formatted with segment markers
- **Tests:** `test_segment_identity.py` (plan vectors), `test_deepgram_stt_adapter` updated

## E. Analysis cache identity (Step 3)

- **New:** `demoRecordAUDIOMID/ai-service/app/services/analysis_versioning.py`
- **`AnalysisCacheIdentity`:** in-memory `normalized_domain_mode`; domain part in idempotency hash
- **`find_completed_analysis_run_for_identity`:** primary lookup by `idempotency_key` (not `_identity_filters` alone)
- **Domain feature sets:** `grouped-action-plan-v1-{general,it,business}`, `education-study-v1`
- **Tests:** `test_analysis_versioning.py`, updated `test_analysis_scope.py`, `test_analysis_cache_hit_miss.py`

## F–I. (pending)

- Flyway V16 + folder/subject APIs (Step 4–6)
- Education schema/prompt (Step 7)
- OpenAPI + FE (Steps 8–11)
- Full verification (Step 12)

## Test / build log

| Step | Command | Result |
|------|---------|--------|
| Stage A | Git audit | OK |
| Step 2 | `pytest test_segment_identity.py test_deepgram…` | 21 passed |
| Step 3 | `pytest test_analysis_versioning.py test_analysis_scope.py test_analysis_cache_hit_miss.py` | All passed |
| Step 3 | `ruff check` (changed files) | OK after `build_analysis_analyzer` import restore |

## Remaining issues

- `main.py` transcript GET path uses `resolve_segment_id_for_read` but batch `format_transcript_for_analysis` in `ai_analyzer.py` unchanged (pipeline uses `format_aligned_transcript_for_analysis` instead)
- Legacy runs with `grouped-action-plan-v1` (no domain suffix) intentionally cache-miss per plan §6.4
- Git Stage B not run (by design)
