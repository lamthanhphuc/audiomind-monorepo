# Transcript UI Readability

## Goal
Phase 6A improves upload and realtime transcript readability in the FE without changing transcription logic, speaker routing, STT quality, Gemini analysis, or backend behavior unless a backend gap is proven to block the UI.

## Current UI Problem
- Upload transcript is rendered as one long inline text block.
- Speaker labels are embedded in the same paragraph as the transcript text.
- Long uploads are hard to scan, especially in demo mode.
- The current layout does not visually separate speakers, so readability degrades quickly for multi-speaker and long-form transcripts.

## Current Flow

### Where transcript data comes from
- Upload flow in `FE-Audiomind/src/App.tsx` calls `uploadToMeetingApi(...)`, then `startProcessingByPath(...)`, then polls until completion.
- After processing completes, FE calls `getTranscript(meetingId)` and `getAnalysis(meetingId)` in parallel.
- `getTranscript(...)` returns `TranscriptResponse`, whose FE contract already exposes `transcripts: TranscriptSegment[]` with `speaker`, `start_time`, `end_time`, and `text`.

### Where upload transcript is rendered
- `App.tsx` currently normalizes `transcript.transcripts || []` with `normalizePersistedTranscriptSegments(...)`, merges them with `mergeTranscriptSegments(...)`, then flattens the result into a single string:
  - `${segment.speaker}: ${segment.text}`
  - joined with spaces
- That flattened string is stored in `result.transcript`.
- The upload result UI renders that string in a single paragraph: `<p data-testid="e2e-transcript"><strong>Transcript:</strong> {transcriptText}</p>`.

### Whether structured fragments are available
- Yes. The upload response already provides structured transcript fragments/segments through `transcript.transcripts`.
- `normalizePersistedTranscriptSegments(...)` and `mergeTranscriptSegments(...)` already preserve `speaker`, `start`, `end`, `timestamp`, `text`, and `isFinal` for display.

### Whether realtime transcript component can be reused
- Yes. Realtime UI already uses `FE-Audiomind/src/components/RealtimeTranscript.tsx`.
- `App.tsx` passes `liveTranscriptSegmentsForDisplay` into `RealtimeTranscript`, which already renders speaker rows, timestamps, scrollable overflow, and an empty state.
- Upload and realtime currently use different UI paths, even though both are powered by the same transcript utility layer.

### Existing API shape and timestamps
- FE types show timestamps are already present on transcript segments: `start_time` and `end_time`.
- `RealtimeTranscript` formats timestamps with `formatTranscriptTimestamp(...)` and shows them when available.
- For upload transcript, no separate timestamp display exists yet, even though the data contract appears to support it.

### Existing tests around transcript rendering
- `FE-Audiomind/src/components/RealtimeTranscript.test.tsx` covers timestamp formatting, hydrated fragment rendering, empty state, and fallback speaker rendering.
- `FE-Audiomind/src/App.test.tsx` covers transcript hydration/merge helpers, but not upload transcript rendering as readable blocks.
- There is no dedicated test today for parsing plain-text upload transcript markers into display blocks.

## Scope
- Transcript rendering and readability only.
- Upload transcript formatting.
- Optional reuse for realtime transcript if a shared component already exists or becomes the cleanest path.
- Speaker block/card UI.
- Max-height plus scroll area for long transcripts.
- Whitespace and line-break improvements.
- Safe fallback parsing for plain text when structured segments are not available.

## Out of Scope
- Gemini enrichment.
- Keywords.
- Pain points.
- IT term highlighting.
- STT quality improvement.
- Deepgram tuning.
- Speaker diarization improvement.
- Upload language routing.
- Realtime WebSocket changes.
- Backend schema changes unless strictly required by a blocking data gap.

## Preferred Implementation Direction
1. Prefer existing structured transcript segments/fragments if available.
2. If only plain text is available, add a small FE parser for display-only fallback behavior.
3. Render each parsed segment as a separate readable block/card.
4. Do not mutate transcript data; formatting should stay presentation-only.
5. Reuse the existing realtime transcript visual language if that keeps the FE consistent.

## UI Requirements
- Show a speaker badge, for example `SPEAKER_1`.
- Show the transcript text below the speaker badge.
- Show a timestamp row if `start`/`end` exists.
- Add spacing between segments so each speaker turn is visually distinct.
- Cap the transcript area with `max-height` and enable scrolling for long uploads.
- Preserve an empty state when transcript data is missing.
- Keep loading states unchanged unless the current UI already provides one.
- Do not break mobile or responsive layouts.
- Preserve readability and copyability of the transcript text.

Example visual structure:

```text
SPEAKER_1
Transcript text...
0:00 - 0:05

SPEAKER_2
Transcript text...
0:05 - 0:10
```

## Parser Requirements
If a parser is needed for the fallback path:
- Input: plain transcript string.
- Output: array of display segments.
- Support speaker labels like:
  - `SPEAKER_1:`
  - `SPEAKER_2:`
  - `Speaker 1:` only if that pattern already appears in app output and is required for compatibility.
- Do not split normal text incorrectly.
- Fall back to one segment if no speaker marker exists.
- Preserve punctuation and multilingual text.
- Keep the parser deterministic and unit-testable.
- Treat marker parsing as display logic only, not as a rewrite of the source transcript.

## Timestamp Handling
- If backend or structured segment data provides `startTime`/`endTime` or normalized `start`/`end`, display formatted time.
- If upload transcript does not include timestamps, omit time gracefully.
- Do not invent timestamps.
- Do not infer timestamps from plain text unless the existing data already supports it.

## Acceptance Criteria
- Upload transcript no longer appears as one long inline block.
- Plain text `SPEAKER_X:` output is rendered as separate speaker blocks.
- Existing structured segment data, if available, is rendered without lossy conversion.
- Long transcripts are scrollable and do not break page layout.
- Missing transcript displays an empty state.
- Realtime transcript smoke coverage still passes if the shared component is touched.
- Upload `vi`/`en`/`multi` transcript still displays correctly.
- No backend, STT, or Gemini behavior changes are introduced.
- Tests pass.

## Testing Plan

### Targeted FE tests to add or update
- Parser splits `SPEAKER_1:` / `SPEAKER_2:` transcript into segments.
- Parser falls back to one segment when there is no speaker marker.
- Upload transcript renders multiple speaker blocks.
- Transcript with Vietnamese, English, or mixed text is preserved.
- Long transcript UI does not duplicate content.
- Existing realtime transcript test still passes if a shared component is reused.

### Manual tests
- Upload Vietnamese audio and inspect transcript readability.
- Upload English audio and inspect transcript readability.
- Upload multi-language audio and inspect transcript readability.
- Run the realtime Vietnamese single-speaker smoke test to ensure there is no regression.

## Likely Files To Inspect
- `FE-Audiomind/src/App.tsx`
- `FE-Audiomind/src/components/RealtimeTranscript.tsx`
- `FE-Audiomind/src/components/RealtimeTranscript.css`
- `FE-Audiomind/src/utils/transcript.ts`
- `FE-Audiomind/src/services/api.ts`
- `FE-Audiomind/src/types.ts`
- `FE-Audiomind/src/App.test.tsx`
- `FE-Audiomind/src/components/RealtimeTranscript.test.tsx`
- `FE-Audiomind/src/components/*.test.tsx`
- `FE-Audiomind/src/utils/*.test.ts`

## Implementation Plan For Later
1. Identify the current upload transcript rendering path.
2. Decide whether to reuse the existing transcript component or create a small display component.
3. Add a parser utility only if a plain-text fallback is needed.
4. Add a transcript segment list / transcript display component if that is the cleanest reuse point.
5. Render upload transcript in blocks or cards instead of a single paragraph.
6. Add CSS or layout rules for max-height scrolling and spacing.
7. Add targeted FE tests.
8. Run FE targeted tests and build.
9. Browser-test upload `vi`/`en`/`multi` transcript readability.
10. Commit in a logical follow-up change set.

## Risks / Known Limitations
- Plain-text parsing may not recover timestamps.
- Speaker labels from Deepgram may be noisy.
- Diarization quality is not fixed in this phase.
- Very long transcripts may still need pagination or chunking later.
- Multi-language transcript quality remains a separate problem from readability.
- Parsing `SPEAKER_\d+:` text must stay conservative so it does not split legitimate transcript content by accident.
