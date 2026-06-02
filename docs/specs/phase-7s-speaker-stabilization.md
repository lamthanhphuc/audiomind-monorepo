# Phase 7S Speaker Stabilization Spec

## Goal

Phase 7S adds a dedicated speaker stabilization / diarization polish layer so that readable transcript, DOCX evidence preview, and FE transcript display use stable speaker labels even when Deepgram diarization jumps between many labels within one meeting.

Target flow:

Deepgram STT / diarization
-> raw transcript rows with preserved provider speaker
-> speaker stabilization layer
-> stable display speaker rows + speaker stats
-> readable transcript / DOCX preview / meeting detail UI

Raw transcript export remains unchanged.

Compatibility rule for the first 7S PR: do not rename or remove the existing
`speaker` field. User-facing stabilized rows may continue to populate `speaker`
with the stable display speaker so existing FE components, DTOs, and report
builders keep working while raw/provider speaker is preserved separately.

## Current Architecture Summary

### STT and diarization

- `DeepgramSTTAdapter` already extracts speaker labels from Deepgram utterances, words, and alternatives.
- `pipeline.py` currently normalizes speaker labels again into `SPEAKER_n` labels before downstream processing.
- The current path does not keep a separate provider/raw speaker field and a stable display speaker field.
- Because existing consumers already depend on `speaker`, the first 7S implementation should treat `speaker` as the display-compatible field and add raw/provider metadata beside it instead of breaking DTOs.

### Transcript consumers

- `ProcessingService` builds raw, readable, and DOCX transcript evidence rows from saved transcript payloads.
- `generateMeetingTranscriptTxt(...)` and `generateMeetingTranscriptCsv(...)` use the row speaker value directly.
- `MeetingReportDocxGenerator` renders transcript evidence rows directly from `rawTranscriptRows`.
- FE `RealtimeTranscript.tsx` and `TranscriptDisplay.tsx` render `segment.speaker` with presentation-only normalization.
- `App.tsx` already sorts/merges transcript segments for display, but it does not create a dedicated speaker stabilization contract.
- FE display merging may remain as a fallback for legacy/hydration edge cases, but it should consume backend-stabilized rows when available.

### Existing guardrails to preserve

- Do not rewrite the 7Q canonical transcript pipeline.
- Do not reintroduce Whisper, Ollama, or pyannote.
- Do not change ownership or export gating.
- Do not make raw transcript export cleaner; raw must stay audit/debug friendly.
- Do not add database migrations if the existing metadata payload can safely carry speaker stabilization metadata.
- Do not change the canonical transcript version/hash in 7S unless there is an explicit, documented need; defer cache/hash invalidation policy to 7U or ask for confirmation first.

## Scope Baseline

This phase is about presentation stability, not diarization research.

In scope:

- stabilize speaker labels across readable transcript and transcript preview surfaces
- preserve provider/raw speaker values
- add speaker stats metadata for observability and tuning
- sort readable/canonical display rows by timestamp
- collapse tiny fragments and short speaker islands when safe
- merge consecutive same-speaker rows when continuity is strong
- keep large gaps and distinct turns separate

Out of scope:

- no Whisper/Ollama/pyannote
- no Gemini rerun policy change
- no analysis cache/hash invalidation policy change
- no 7Q canonicalizer rewrite
- no ownership/export gate change
- no Docker cleanup

## Definitions

### Raw speaker

The provider- or adapter-originated speaker label. This must remain preserved for audit/debug, even if the display speaker changes.

### Stable display speaker

A normalized presentation label such as `SPEAKER_1`, `SPEAKER_2`, ... that remains consistent across nearby rows and across display/export surfaces.

### Speaker island

A short run of speaker-labeled rows that is surrounded by the same speaker and is likely a false diarization jump.

### Tiny segment

A very short row that is likely to be a split artifact rather than a meaningful conversational turn.

## Requirements

### Speaker preservation

REQ-001: The system must preserve the provider/raw speaker label for every transcript row that arrives with diarization metadata.

REQ-002: The system must expose a stable display speaker label for user-facing transcript rows without overwriting or losing the preserved raw/provider speaker label.

REQ-003: The system must keep raw transcript export unchanged, even when the stable display speaker map changes.

REQ-003a: The first 7S PR must not rename or remove the existing `speaker` field. For stabilized user-facing rows, `speaker` may remain the stable display speaker to preserve FE/DTO backward compatibility.

REQ-003b: Raw/provider labels must be stored in a separate field or metadata payload, such as `providerSpeaker`, `originalSpeaker`, `speakerStabilizationVersion`, and `speakerStats`.

REQ-003c: If adding top-level fields is unsafe for the current schema, the implementation must use an existing metadata map or sidecar metadata object rather than creating a migration by default.

### Speaker stabilization

REQ-004: The system must assign stable display speakers using a deterministic first-seen mapping so nearby rows with the same conversational identity keep the same `SPEAKER_n` label.

REQ-005: The system must merge consecutive rows from the same speaker when the rows are adjacent or nearly adjacent and the combined segment remains short enough to read as one turn.

REQ-006: The system must merge a short speaker island into the surrounding speaker when the same speaker appears on both sides and the island stays within a safe time window.

REQ-007: The system must merge tiny fragments into the nearest compatible speaker turn when the merge does not cross a large silence or create an overly long segment.

REQ-008: The system must not merge rows across a large gap even if the speaker label is the same.

REQ-009: The system must sort stabilized readable rows by timestamp before rendering or export.

REQ-010: The system must cap the stable speaker map to a reasonable number of speakers and keep behavior predictable when Deepgram emits more labels than expected.

REQ-010a: The system must cap merged turn duration with `SPEAKER_MAX_MERGED_TURN_SECONDS` so stabilization cannot create unreadably long turns.

### Speaker stats metadata

REQ-011: The system must produce speaker stats metadata for each meeting run, including at minimum raw speaker count, stabilized speaker count, merged islands count, merged tiny fragments count, and largest observed speaker label count.

REQ-012: The system must include the stabilization version in the transcript metadata so exports and tests can identify which speaker normalization rules were used.

### Readable surfaces

REQ-013: Readable TXT export must use stable display speaker labels rather than raw provider speaker labels.

REQ-014: DOCX transcript evidence preview must use stable display speaker labels rather than raw provider speaker labels.

REQ-015: Meeting detail transcript UI must use stable display speaker labels rather than raw provider speaker labels.

### Analysis behavior

REQ-016: Phase 7S must not automatically rerun Gemini analysis when the speaker stabilization version changes.

REQ-017: Analysis cache/hash invalidation belongs to Phase 7U. Phase 7S only improves readable/export/UI speaker labels and records enough metadata for future cache decisions.

## Proposed Config Defaults

The stabilization layer should read these defaults from config/env:

- `SPEAKER_STABILIZATION_ENABLED=true`
- `SPEAKER_STABILIZATION_VERSION=speaker-stabilization-v1`
- `SPEAKER_MIN_SEGMENT_SECONDS=1.2`
- `SPEAKER_MAX_GAP_SECONDS=1.0`
- `SPEAKER_ISLAND_MAX_SECONDS=2.0`
- `SPEAKER_MAX_MERGED_TURN_SECONDS=20.0`
- `SPEAKER_MAX_REASONABLE_COUNT=8`
- `SPEAKER_STABILIZATION_DRY_RUN=false`
- `SPEAKER_STABILIZATION_LOG_STATS=true`

Behavioral interpretation:

- `SPEAKER_MIN_SEGMENT_SECONDS` controls what counts as a tiny fragment.
- `SPEAKER_MAX_GAP_SECONDS` controls whether consecutive rows may be merged.
- `SPEAKER_ISLAND_MAX_SECONDS` controls whether a short speaker island can be absorbed by surrounding continuity.
- `SPEAKER_MAX_MERGED_TURN_SECONDS` prevents any merge rule from creating an overly long display turn.
- `SPEAKER_MAX_REASONABLE_COUNT` prevents label explosion from producing an unbounded display map.
- `SPEAKER_STABILIZATION_DRY_RUN` allows logging speaker stats before applying stabilized display speakers, if a rollout wants an observation-only pass.
- `SPEAKER_STABILIZATION_LOG_STATS` controls structured logging of raw/stable speaker counts and merge decisions.

## Data Contract Proposal

Backward-compatible stabilized row shape for user-facing surfaces:

```txt
speaker                  # existing field; stable display speaker for user-facing rows
providerSpeaker          # raw/provider label when safe to add top-level fields
originalSpeaker          # pre-stabilization label when distinct from providerSpeaker
speakerStabilizationVersion
speakerStats
```

If adding top-level fields would break the current schema or DTO mapping, keep
`speaker` as the stable display speaker and store raw/provider values in an
existing metadata map or sidecar metadata object instead:

```txt
speaker
metadata.providerSpeaker
metadata.originalSpeaker
metadata.speakerStabilizationVersion
metadata.speakerStats
```

Recommended meeting/report metadata additions:

```txt
speakerStabilizationVersion
speakerStats
rawSpeakerCount
stableSpeakerCount
mergedIslandCount
mergedTinyFragmentCount
```

`speakerStats` must include at minimum:

```txt
rawSpeakerCount
stableSpeakerCount
mergedIslandCount
mergedTinyFragmentCount
stabilizationVersion
```

Raw/provider speaker must stay available on the underlying row or metadata
sidecar for audit and debugging. Raw export must use the raw/provider value or
otherwise bypass the stabilizer so it is not rewritten by presentation cleanup.

## Behavior Rules

### Stable display mapping

- The first meaningful speaker label seen in a meeting becomes the first stable display speaker.
- Subsequent rows reuse the same stable label when they belong to the same continuity chain.
- Unknown or empty speaker values should fall back to a deterministic default label rather than creating new noise labels.

### Merge logic

- Merge consecutive same-speaker rows when the time gap is at or below the configured gap threshold.
- Merge a short island only when all guard conditions pass:
  - island duration is at or below `SPEAKER_ISLAND_MAX_SECONDS`
  - gap on both sides is at or below `SPEAKER_MAX_GAP_SECONDS`
  - the same surrounding speaker appears immediately before and after the island
  - island text has fragment/split-artifact signals, such as incomplete text or missing terminal punctuation
  - the combined surrounding turn would remain at or below `SPEAKER_MAX_MERGED_TURN_SECONDS`
- Merge tiny fragments when they are too short to stand alone and the merge does not create a long or unnatural segment.
- Do not merge across large gaps or into a segment that becomes too long to read comfortably.
- Do not merge an island that appears to be an independent turn, for example when it has clear sentence punctuation, meaningful standalone text, a large surrounding gap, or would create an overly long combined turn.

### Sorting

- All readable and export-facing stabilized rows must be sorted by timestamp before presentation.
- Sorting must not mutate raw row order used for audit/debug export.

## Consumer Plan

1. Apply stabilization after raw Deepgram rows are assembled.
2. Preserve raw speaker and raw rows.
3. Build stable display rows for readable transcript, DOCX preview, and meeting detail UI.
4. Leave raw export path unchanged.
5. Surface speaker stats in transcript metadata and report metadata.

### Stabilization layer placement

- Source of truth should live in the backend after Deepgram/raw transcript rows are assembled and before readable/export/UI surfaces consume display rows.
- Do not implement 7S as FE-only cleanup because readable TXT and DOCX preview would still expose noisy speaker labels.
- Do not rewrite the 7Q canonicalizer. The stabilization layer should sit beside/after raw row assembly and feed presentation surfaces with stable rows.
- If FE merge logic remains useful, it should consume stable backend rows or act only as a fallback for legacy rows that do not yet carry stabilization metadata.

## Testing Plan

### Unit and integration tests

- mock Deepgram rows with repeated speaker jumps such as `SPEAKER_1 -> SPEAKER_17 -> SPEAKER_1`
- verify raw speaker values are still preserved on the raw row contract
- verify stable speaker rows collapse the jumps into fewer display labels
- verify a short speaker island is merged when the same speaker surrounds it
- verify tiny fragments merge into neighboring rows only when the gap is safe
- verify no merge happens across a large gap
- verify readable TXT export uses the stable display speaker label
- verify DOCX evidence preview uses the stable display speaker label
- verify meeting detail UI uses the stable display speaker label
- verify speaker stats metadata is emitted and versioned
- verify 7S does not trigger Gemini reruns or analysis cache invalidation
- verify no Whisper/Ollama/pyannote code path is introduced
- verify no `.env` changes are required

### Suggested test data shapes

- one long turn split into several tiny rows
- one false one-row speaker island between the same speaker on both sides
- one same-speaker pair separated by a large silence
- one transcript with more than `SPEAKER_MAX_REASONABLE_COUNT` distinct labels

## Definition of Done

- Deepgram raw speaker is preserved.
- The existing `speaker` field is not renamed or removed in the first 7S PR.
- Stable display speaker labels are available without losing raw/provider labels.
- Readable TXT, DOCX preview, and meeting detail UI all use the stabilized speaker labels.
- Raw export remains unchanged.
- Speaker stats metadata is available and versioned.
- Tests cover speaker jumps, island merge, tiny fragment merge, and large-gap non-merge.
- Gemini analysis is not automatically rerun by speaker stabilization version changes.
- No Whisper/Ollama/pyannote dependency or path is reintroduced.
- No `.env` changes are required.

## Measurable Acceptance Criteria

- `vn.mp3` produces a low stable speaker count, ideally 1-2 stable speakers if the audio is a single-speaker sample.
- `en.mp3` stable speaker count is clearly lower than raw/provider speaker count on the known noisy sample.
- Readable TXT export uses stable display speaker labels.
- DOCX preview/evidence rows use the same stable display speaker labels as readable TXT.
- Raw export continues to use raw/provider speaker labels or otherwise bypasses the stabilizer so raw speaker data is not rewritten.
- FE meeting detail displays the same stable speaker labels as readable export for the same rows.
- `speakerStats` includes `rawSpeakerCount`, `stableSpeakerCount`, `mergedIslandCount`, `mergedTinyFragmentCount`, and `stabilizationVersion`.
- The implementation does not add Whisper, Ollama, or pyannote usage.
- The implementation does not change real `.env` files.

## Implementation Warnings

- Do not create a migration or new database table if the existing transcript/report metadata payload can safely store the added speaker stabilization fields.
- Do not change the 7Q canonical transcript version/hash in 7S unless the implementation genuinely requires it and the reason is documented.
- If changing canonical hash/version is required, defer that work to 7U or ask the user to confirm the broader cache invalidation behavior.

## Risks

- Over-aggressive merging could hide genuine speaker changes.
- Under-aggressive merging may still leave noisy labels visible in long meetings.
- Different languages and speaking styles may need tuning around gap and island thresholds.
- If the stabilization layer is applied inconsistently across consumers, the UI and exports may diverge.

## Out of Scope

- No Whisper/Ollama/pyannote.
- No 7Q canonicalizer rewrite.
- No Gemini rerun policy change.
- No ownership/export gate change.
- No Docker cleanup.

## Recommended Implementation Order

1. Add speaker preservation fields to the transcript row contract.
2. Implement a stabilization layer that produces stable display rows and speaker stats.
3. Route readable TXT export and DOCX preview to stabilized rows.
4. Route meeting detail UI to stabilized rows.
5. Keep raw export untouched.
6. Add tests for merge thresholds, island merge, raw preservation, and speaker stats.
