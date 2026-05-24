# Upload Transcript Display Grouping

## Goal
Improve upload transcript readability by grouping adjacent short transcript segments into larger display blocks without changing stored transcript data.

## Current Problem
- Upload transcript cards are readable but still too fragmented.
- Some cards contain only one word (for example: "hoặc").
- Short fragments interrupt reading flow and make scanning difficult.
- This hurts demo quality even when transcript content is technically correct.
- Transcript data itself should remain unchanged.

## Current Flow in Codebase
- Upload transcript pipeline in FE currently uses:
  - `getTranscript(...)` -> `normalizePersistedTranscriptSegments(...)` -> `mergeTranscriptSegments(...)` -> `result.transcriptSegments`.
  - `TranscriptDisplay` renders `result.transcriptSegments` directly as speaker cards.
- Realtime pipeline currently has its own display path:
  - `liveTranscriptSegmentsForDisplay` may call `mergeTranscriptSegmentsForDisplay(...)`.
  - Realtime renders through `RealtimeTranscript`, not `TranscriptDisplay`.
- Existing grouping logic in utils is currently tuned for realtime display behavior and should not be implicitly changed for upload unless explicitly scoped.

## Options Considered

1. Deepgram paragraphs
- Pros: native paragraph readability.
- Cons: requires backend/STT request and response handling changes; higher integration and regression risk.
- Decision: out of scope for first implementation.

2. Deepgram utterances
- Pros: semantic units with timestamps.
- Cons: requires backend/STT request and response handling changes; response mapping risk.
- Decision: out of scope for first implementation.

3. FE display grouping
- Pros: safest, FE-only, no persistence changes.
- Cons: heuristic-based and not perfect semantic paragraphing.
- Decision: chosen approach for Phase 6C.

## Chosen Approach
Use a display-only grouping function:
- Input: existing transcript segments.
- Output: grouped display segments.
- No mutation of original segment list.
- Only used for upload transcript display.
- Realtime transcript should remain unchanged unless explicitly opted in later.

Preferred integration point:
- Add grouping utility in `FE-Audiomind/src/utils/transcript.ts`:
  - `groupUploadTranscriptSegmentsForDisplay(segments, options)`.
- Apply grouping in `TranscriptDisplay` through an explicit upload-only prop or mode:
  - Example: `enableDisplayGrouping={true}`.
  - Example: `mode="upload"`.
- Do not mutate `result.transcriptSegments` in `App.tsx` unless implementation analysis later proves that path is safer.
- Keep original `transcriptSegments` available for analysis/export/debug.

## Grouping Rules
Initial heuristic policy:

A segment can merge with adjacent segment if:
- Same speaker.
- Both have valid or compatible timestamp order.
- No speaker change between them.
- Combined text length does not exceed a configurable limit (initial target: 500-700 characters).
- Combined duration does not exceed a configurable limit (initial target: 60-90 seconds).
- Gap is small enough (initial target: <= 3-5 seconds).
- And at least one condition is true:
  - Current segment is very short: <= 3 words.
  - Current segment has <= 15-20 characters.
  - Current segment duration <= 1.5 seconds.
  - Current segment lacks sentence-ending punctuation and next segment appears to continue the same thought.

Do not merge if:
- Speaker changes.
- Segment has meaningful sentence-ending punctuation and next gap is large.
- Combined block becomes too long.
- Timestamps are invalid in a way that would produce misleading ranges.
- Segment belongs to realtime live transcript.

Deterministic merge direction:
- For a very short segment, first prefer merge with previous segment if same speaker and gap is small.
- Otherwise try merge with next segment.
- If both previous and next merges are valid, choose the option that produces more natural punctuation/spacing and smaller timestamp gap.
- Never merge across speaker changes.
- Never reorder segments.

Safe fallback behavior:
- If timestamps are missing/invalid, grouping may still merge adjacent same-speaker very-short text only when order is clear from array order.
- If ordering/timing confidence is unclear, leave segments unchanged.
- Grouping must never throw; on unexpected parsing/edge cases, return best-effort unchanged output.

Initial internal constants (not env/config):
- `SHORT_SEGMENT_MAX_WORDS = 3`
- `SHORT_SEGMENT_MAX_CHARS = 20`
- `SHORT_SEGMENT_MAX_DURATION_SECONDS = 1.5`
- `MERGE_MAX_GAP_SECONDS = 5`
- `MERGE_MAX_TEXT_CHARS = 700`
- `MERGE_MAX_DURATION_SECONDS = 90`

## Timestamp Handling
When merging:
- `startTime` = first segment `startTime`.
- `endTime` = last segment `endTime`.
- Preserve speaker.
- `text` = joined text with clean spacing.
- Preserve confidence if available by weighted/average strategy, or omit confidence aggregation when used for display-only grouping.
- Preserve source segment count internally if useful for debugging/tests.

## Text Cleanup
- Trim duplicate spaces.
- Avoid joining punctuation incorrectly.
- Support Vietnamese punctuation patterns.
- Do not alter words semantically.
- Do not fix STT mistakes in this phase.

## Data Safety
- Grouping is display-only.
- No API contract change.
- No DB migration.
- No backend mutation.
- Original `transcriptSegments` remain available for analysis/export/debug.
- Gemini analysis should continue to use original transcript, not grouped display text, unless explicitly decided in a later phase.

## UI Plan
- Grouped card still shows speaker badge.
- Grouped card shows merged timestamp range.
- Optional small label like `3 segments` only if helpful; default is no label to avoid clutter.
- Keep current scroll behavior.
- Long grouped block should wrap cleanly.
- Empty state remains unchanged.

Before/after readability example:

Before:
```text
SPEAKER_1
4:40 - 4:41
hoặc

SPEAKER_1
4:45 - 5:03
giảng viên tại các trường...
```

After:
```text
SPEAKER_1
4:40 - 5:03
hoặc giảng viên tại các trường...
```

## FE Implementation Plan For Later
Do not implement in this phase spec; implementation steps for next execution phase:
1. Add a utility in `FE-Audiomind/src/utils/transcript.ts`:
   - `groupUploadTranscriptSegmentsForDisplay(segments, options)`.
   - This can be a dedicated implementation or a wrapper over shared merge primitives with upload-specific thresholds.
2. Use it in `TranscriptDisplay` with explicit upload-only control (for example `enableDisplayGrouping` or `mode="upload"`), while preserving current realtime rendering behavior.
3. Keep realtime rendering path unchanged.
4. Add threshold constants with clear names and comments.
5. Add unit tests for utility behavior.
6. Add UI tests for grouped rendering.

## Testing Plan
Add tests for:
- Merges one-word segment with neighboring same-speaker segment.
- Merges short segment with next segment when gap is small.
- Does not merge across different speakers.
- Does not merge when gap is too large.
- Does not exceed max block length.
- Preserves timestamp range after merge.
- Preserves original segment array (immutability).
- Handles missing timestamps safely.
- Keeps single long segment unchanged.
- Vietnamese text spacing and punctuation remain readable.
- `TranscriptDisplay` renders grouped upload blocks.
- Deterministic merge direction is respected (prefer previous for very-short segment when valid; otherwise next).
- Grouping never throws and safely falls back to unchanged output when required.
- Internal threshold constants are used in utility code (not env/config).
- `RealtimeTranscript` render path remains unchanged and does not call `groupUploadTranscriptSegmentsForDisplay` in Phase 6C.

## Manual Test Plan
Test scenarios:
- Upload Vietnamese IT audio that previously had one-word blocks.
- Upload English audio.
- Upload multi-language audio.
- Realtime `vi` + single-speaker smoke test.

Expected:
- Fewer one-word cards.
- Transcript remains chronological.
- No speaker mixing.
- Timestamp ranges remain sensible.
- Realtime transcript behavior unchanged.
- Gemini analysis panel unaffected.

## Out of Scope
- No Deepgram/STT request changes.
- No `paragraphs=true` implementation.
- No `utterances=true` implementation.
- No Gemini changes.
- No realtime transcript grouping changes.
- No DB migration.
- No API contract change.
- No diarization improvement.
- No STT quality correction.
- No IT term highlighting.

## Acceptance Criteria
- Upload transcript display has fewer tiny cards.
- One-word/super-short segments merge into nearby same-speaker blocks when safe.
- No merge across speakers.
- No mutation of original data.
- Existing transcript readability tests pass.
- Phase 6B structured analysis UI still works.
- Realtime smoke test passes.
- No backend/contracts changed.
- `TranscriptDisplay` grouping does not affect `RealtimeTranscript`.
- `RealtimeTranscript` does not call `groupUploadTranscriptSegmentsForDisplay` in Phase 6C.

## Risks / Known Limitations
- Heuristic grouping may not perfectly match semantic paragraphs.
- Poor STT timestamps may limit safe merging opportunities.
- If Deepgram paragraph/utterance-level segmentation is needed later, do it in a separate backend/STT phase.
- Display grouping can hide exact original segment boundaries visually, so original raw segments must remain available internally.

## Notes on Deepgram Alternatives (Research)
- Deepgram `paragraphs=true` improves readability via paragraph segmentation but requires STT/backend integration changes.
- Deepgram `utterances=true` returns semantic utterance units with timestamps but also requires STT/backend response mapping changes.
- Therefore, Phase 6C intentionally prioritizes FE display grouping as the lowest-risk first step.
