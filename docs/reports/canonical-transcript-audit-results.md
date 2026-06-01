# Canonical Transcript Pipeline Audit Results

## Scope

- Branch: `feature/canonical-transcript-pipeline-spec`
- Target phase: `7Q - Canonical Transcript Pipeline`
- Status: audit only, no runtime implementation

## Method

- CodeGraph commands used:
  - `codegraph status`
  - `codegraph context "7Q canonical transcript pipeline storage decision backfill internal CLI Gemini invalidation policy"`
  - `codegraph query "canonical transcript persisted transcript domain ai-service backfill analysis cache transcriptHash"`
  - `codegraph affected`
- `codegraph affected` returned `No files provided. Use file arguments or --stdin.`
- Targeted reads used:
  - `docs/specs/canonical-transcript-pipeline.md`
  - `docs/reports/canonical-transcript-audit-results.md`
  - `docs/specs/gemini-business-analysis-optimization.md`
  - `docs/reports/gemini-analysis-audit-results.md`
  - `docs/specs/auth-ownership-transcript-export.md`
  - `docs/reports/auth-ownership-transcript-audit-results.md`
  - targeted runtime references for transcript and analysis behavior
- No runtime changes.

## Current transcript sources

- processing-service transcript read path:
  - `getTranscript(...)` returns job-state transcript rows when present.
  - falls back to ai-service persisted transcript endpoint when job-state is missing/empty.
- export/report read path:
  - `loadSavedTranscriptRowsForExport(...)` uses same priority (job-state -> ai persisted).
- ai-service transcript read path:
  - prefers visible assembled fragment rows from `transcript_fragments`.
  - falls back to legacy `transcripts` rows.

## Current consumers

| Consumer | Current source | Problem | 7Q recommendation |
| --- | --- | --- | --- |
| Meeting detail transcript UI | `/processing/transcript/{meetingId}` -> job-state or ai persisted transcript | Fragment overlap/repetition leaks to UI | Return canonical rows when available, fallback raw otherwise |
| Readable TXT/CSV export | saved rows + `buildReadableTranscriptRows` | Heuristic-only, still noisy | Use canonical rows as readable source |
| Raw TXT/CSV export | saved rows + `buildRawTranscriptRows` | None for audit use case | Keep raw unchanged |
| DOCX Transcript Evidence Preview | saved rows + readable preview heuristics | Same duplicate/fragment issues | Use canonical rows (bounded preview) |
| Gemini lazy analysis input | `buildTranscriptText(...)` over saved rows | Higher token cost, repeated evidence | Build analysis input from canonical when present |

## MVP decision: canonical persistence

7Q MVP will persist canonical transcript data in the existing ai-service persisted transcript domain as sidecar rows/metadata, while keeping raw transcript rows immutable.

Required canonical metadata:
- canonicalTranscriptRows
- canonicalTranscriptVersion
- canonicalTranscriptHash
- canonicalGeneratedAt
- canonicalStats
- rawTranscriptHash

Rationale:
- This is the lowest-risk durable source because ai-service already owns persisted transcript fragments.
- It avoids relying on Redis/job-state retention.
- It avoids mixing transcript payloads into meeting metadata.
- A new dedicated transcript table can be considered later if the sidecar envelope becomes too large.

## Raw/canonical storage options

| Option | Pros | Cons | MVP status |
| --- | --- | --- | --- |
| Existing ai-service persisted transcript domain (sidecar metadata) | Durable source already used in transcript fallback/export | Needs explicit JSON envelope naming | Selected for 7Q MVP |
| Processing job-state only | Fast to wire | Not durable due Redis retention behavior | Not selected for MVP |
| Meeting-service metadata | Simple FE read shape | Mixes transcript domain into meeting metadata | Not selected for MVP |
| New dedicated transcript table | Clean long-term model | Larger scope and migration cost | Consider post-MVP |

## Recommended MVP architecture

- Keep raw rows immutable for audit/debug.
- Persist canonical sidecar rows and metadata in existing ai-service persisted transcript domain.
- Use `rawTranscriptHash + canonicalTranscriptVersion` for idempotent rebuild checks.
- Read priority:
  1. canonical rows when valid
  2. deterministic canonical build from saved raw rows
  3. persist canonical only in write/backfill paths
- No STT/Gemini calls during canonical generation.

## MVP decision: backfill strategy

7Q MVP should start with an internal service/CLI backfill path, not a public HTTP endpoint.

Backfill should be:
- meeting-scoped first
- idempotent by `(meetingId, rawTranscriptHash, canonicalTranscriptVersion)`
- safe to rerun
- no STT
- no Gemini
- no `/processing/start`
- no lazy analysis trigger

HTTP/admin endpoint can be added later only if needed for operations.

## MVP decision: analysis invalidation policy

7Q MVP must not automatically rerun Gemini analysis when canonical transcript is generated or canonical version changes.

Policy:
- Existing saved analysis remains valid until explicitly rerun.
- New analysis and explicit retry/rerun analysis should prefer canonical transcript when available.
- Analysis cache identity should eventually include canonicalTranscriptHash/canonicalTranscriptVersion, but automatic invalidation is out of scope for 7Q MVP.
- No Gemini call should be triggered by canonicalization/backfill itself.

## API/contract impact

- Keep existing `mode=readable|raw` export contract.
- Route readable transcript consumers to canonical when available.
- Additive transcript metadata fields may be introduced for canonical mode and canonical metadata.
- If FE consumes these fields, update contracts and generated clients in implementation phase.
- No breaking endpoint changes required for 7Q MVP.

## Test plan

- Canonicalizer determinism and duplicate/fragment handling.
- Raw preservation invariants.
- Backfill idempotency and no-STT/no-Gemini/no-processing-start guard.
- Consumer source behavior:
  - readable export uses canonical
  - raw export uses raw
  - DOCX preview uses canonical
  - new/explicit rerun analysis uses canonical when present
- Confirm canonicalization/backfill never auto-reruns Gemini.

## Risks and mitigations

- Aggressive canonical cleanup drops meaning: conservative thresholds + keep-row-on-uncertainty.
- Drift between raw and canonical: persist hash/version/stats.
- Backfill surprises on old meetings: idempotent, meeting-scoped rollout.
- Analysis expectation mismatch: explicit no-auto-rerun policy in 7Q MVP.

## Open questions / blockers

- Exact JSON envelope field names for canonical sidecar storage.
- Whether a dedicated transcript table is needed after MVP.
- Whether admin HTTP backfill is needed after internal CLI/service backfill is validated.
- `codegraph affected` needs explicit file args for implementation-stage dependency mapping.

## Confirmation

- Spec-only
- No runtime changes
- No commit
