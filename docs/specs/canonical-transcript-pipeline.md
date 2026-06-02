# 7Q - Canonical Transcript Pipeline

## 1. Status

- SPEC-ONLY
- Branch: `feature/canonical-transcript-pipeline-spec`
- No runtime changes in this branch

## 2. Background

7P introduced safe raw/readable TXT/CSV export and owner-gated DOCX export. However, readable transcript is still best-effort because saved STT output can contain overlapping fragments, repeated segments, and partial rows.

7Q fixes this at the transcript pipeline level by introducing a canonical transcript layer.

## 3. Problem

Current transcript consumers may read raw STT fragments directly or indirectly:
- meeting detail
- readable TXT/CSV export
- DOCX Transcript Evidence Preview
- Gemini analysis input

This causes:
- repeated rows
- tiny suffix fragments
- partial sentence fragments
- noisy report evidence
- higher token cost and poorer analysis quality

## 4. Goals

- Split transcript into raw and canonical layers.
- Keep raw transcript unchanged for audit/debug.
- Generate canonical transcript deterministically from saved raw/persisted rows.
- Store canonical rows with version/hash metadata.
- Backfill canonical transcript for old meetings.
- Make UI transcript prefer canonical.
- Make Readable TXT/CSV use canonical.
- Make DOCX Transcript Evidence Preview use canonical.
- Make Gemini analysis use canonical when available.
- Never call STT/Gemini during canonical generation/backfill.
- Preserve 7P ownership/security rules.

## 5. Non-goals

- No Gemini-based transcript rewriting.
- No semantic paraphrasing.
- No deletion of raw transcript.
- No vi+en/multi STT provider optimization in this phase.
- No diarization rewrite.
- No PDF export.
- No ownership/auth rewrite.
- No attempt to make transcript perfect.

## 6. Definitions

### Raw transcript

Saved STT/provider output. May contain overlapping fragments, partial rows, duplicate rows, speaker instability, and timing artifacts.

Used for:
- Raw TXT/CSV export
- audit/debug
- fallback evidence

### Canonical transcript

Deterministically cleaned presentation transcript generated from raw rows.

Used for:
- meeting detail transcript
- Readable TXT/CSV
- DOCX Transcript Evidence Preview
- Gemini analysis input
- search/indexing later if needed

## 7. Data model proposal

### MVP decision: canonical persistence

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

Recommended fields:

```txt
rawTranscriptRows
canonicalTranscriptRows
canonicalTranscriptVersion
canonicalTranscriptHash
canonicalGeneratedAt
canonicalStats
rawTranscriptHash
```

Raw/canonical storage options:

| Option | Pros | Cons | MVP status |
| --- | --- | --- | --- |
| Existing ai-service persisted transcript domain (sidecar metadata) | Durable source already used by transcript fallback and export paths | Needs clear JSON envelope naming | Selected for 7Q MVP |
| Processing job-state only | Fastest to wire | Redis retention is not a durable transcript source | Not selected for MVP |
| Meeting-service metadata | Simple FE read path | Mixes transcript domain into meeting metadata | Not selected for MVP |
| New dedicated transcript table/storage | Clean long-term model | Larger phase and migration cost | Consider post-MVP |

Recommended MVP architecture:

- Persist canonical rows and canonical metadata in existing ai-service persisted transcript domain as sidecar data.
- Keep raw transcript rows immutable.
- Use `rawTranscriptHash + canonicalTranscriptVersion` to detect staleness and rebuild conditions.
- Keep canonical generation deterministic and rebuildable.

## 8. Canonicalizer design

Create a deterministic service/helper:

```txt
TranscriptCanonicalizer
```

Input:

```txt
List<TranscriptRow> rawRows
CanonicalizationOptions
```

Output:

```txt
CanonicalTranscriptResult {
  rows,
  version,
  hash,
  stats
}
```

Rules:

- sort by start time
- drop empty/noise rows
- normalize text only for comparison
- preserve original chosen text in output
- remove exact duplicates
- remove tiny contained fragments when a nearby fuller sentence covers them
- prefer longer coherent row over nearby partial rows
- conservatively collapse overlap
- keep speaker/timing from selected source row or safe range
- do not paraphrase
- do not invent content
- if uncertain, keep the row
- produce stats: inputRows, outputRows, droppedDuplicates, droppedFragments, version

## 9. Source priority

When reading transcript for user-facing consumers:

```txt
1. canonicalTranscriptRows if present and version matches rawTranscriptHash
2. build canonical from saved raw/persisted transcript rows
3. in write/backfill path, persist canonical sidecar rows/metadata
4. in read-only path, avoid side effects unless explicitly allowed
```

Raw export always uses raw rows.

## 10. Backfill plan

### MVP decision: backfill strategy

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

Operational notes:

- Backfill reads saved raw/persisted transcript rows only.
- Backfill writes canonical sidecar rows/metadata only.
- Backfill must not mutate raw rows.

## 11. Consumer migration plan

### MVP decision: analysis invalidation policy

7Q MVP must not automatically rerun Gemini analysis when canonical transcript is generated or canonical version changes.

Policy:
- Existing saved analysis remains valid until explicitly rerun.
- New analysis and explicit retry/rerun analysis should prefer canonical transcript when available.
- Analysis cache identity should eventually include canonicalTranscriptHash/canonicalTranscriptVersion, but automatic invalidation is out of scope for 7Q MVP.
- No Gemini call should be triggered by canonicalization/backfill itself.

Recommended order:

1. Readable TXT/CSV export uses canonical.
2. DOCX Transcript Evidence Preview uses canonical.
3. Meeting detail transcript uses canonical.
4. New analysis or explicit retry/rerun uses canonical transcript when available.
5. Keep raw TXT/CSV unchanged.

## 12. API/contract impact

Potential additions:

- transcript response may expose `transcriptMode=canonical|raw`
- transcript response may expose canonical metadata fields
- export keeps existing `mode=readable|raw` API; `readable` resolves from canonical when available
- processing contract update only if FE needs explicit canonical metadata fields
- generated client update if FE consumes new fields

Analysis policy impact:

- 7Q does not auto-invalidate saved analysis when canonical is generated.
- 7Q does not auto-trigger Gemini from canonicalization/backfill.
- Future analysis cache identity should include canonical hash/version when analysis pipeline adopts canonical-native identity.

Avoid breaking existing 7P endpoints.

## 13. Testing strategy

Backend:

- canonicalizer removes duplicate/fragment rows from sample raw transcript
- canonicalizer preserves raw rows unchanged
- canonicalizer is deterministic
- canonical hash changes when raw transcript or version changes
- backfill creates canonical rows from old meeting raw transcript
- backfill is idempotent
- Readable TXT/CSV uses canonical
- Raw TXT/CSV uses raw
- DOCX preview uses canonical
- new/explicit rerun analysis uses canonical when available
- no STT/Gemini/processing-start during canonicalization/backfill
- ownership behavior unchanged

FE:

- meeting detail shows canonical transcript when available
- readable export still works
- raw export still works
- fallback message when canonical is missing or being generated
- no processing-start call from transcript viewing/export

## 14. Acceptance criteria

7Q is complete when:

- raw/canonical split exists.
- new completed meeting has canonical transcript.
- old meeting can be backfilled.
- Readable TXT/CSV uses canonical.
- DOCX preview uses canonical.
- meeting detail uses canonical.
- new/explicit rerun analysis uses canonical when available.
- Raw TXT/CSV remains raw.
- canonical generation/backfill does not call STT/Gemini.
- canonical generation/backfill does not auto-rerun Gemini analysis.
- tests cover old and new meeting paths.
- 7P ownership/security behavior remains intact.

## 15. Risk matrix

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Canonicalizer drops meaningful content | High | Conservative rules, raw retained, tests |
| Canonical rows diverge from raw | Medium | Store hash/version/stats |
| Backfill mutates too much | High | Idempotent, meeting-scoped first |
| Gemini analysis changes unexpectedly | Medium | Explicit no-auto-rerun policy in 7Q MVP |
| DB migration too large | Medium | Use sidecar persistence in existing transcript domain |
| UI assumes canonical always exists | Medium | Fallback states |
| Provider/STT issue mixed into 7Q | High | Defer provider tuning to 7R |

## 16. 7Q vs 7R boundary

7Q:

- canonical transcript from existing saved output
- deterministic cleanup
- raw/canonical split
- backfill
- consumers use canonical

7R:

- STT provider tuning
- language=multi/code-switching
- endpointing/interim/final tuning
- diarization tuning
- chunking/overlap STT improvements

## 17. Open questions

- Exact JSON envelope field names for canonical sidecar storage.
- Whether a dedicated transcript table is needed after MVP.
- Whether admin HTTP backfill is needed after internal CLI/service backfill is validated.
