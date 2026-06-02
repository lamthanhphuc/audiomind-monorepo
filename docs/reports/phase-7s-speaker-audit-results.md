# Phase 7S Speaker Stabilization Audit Results

## Scope

Audit-only review of the current diarization, transcript display, and export flow to prepare a speaker stabilization / readability polish plan without changing runtime code.

## Files and Areas Reviewed

- [demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py](../../demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py)
- [demoRecordAUDIOMID/ai-service/app/pipeline.py](../../demoRecordAUDIOMID/ai-service/app/pipeline.py)
- [demoRecordAUDIOMID/ai-service/app/main.py](../../demoRecordAUDIOMID/ai-service/app/main.py)
- [demoRecordAUDIOMID/ai-service/app/schemas.py](../../demoRecordAUDIOMID/ai-service/app/schemas.py)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportData.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportData.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportDocxGenerator.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportDocxGenerator.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java)
- [FE-Audiomind/src/utils/transcript.ts](../../FE-Audiomind/src/utils/transcript.ts)
- [FE-Audiomind/src/app/App.tsx](../../FE-Audiomind/src/app/App.tsx)
- [FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx](../../FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx)
- [FE-Audiomind/src/components/transcript/TranscriptDisplay.tsx](../../FE-Audiomind/src/components/transcript/TranscriptDisplay.tsx)
- [FE-Audiomind/src/components/transcript/RealtimeTranscript.test.tsx](../../FE-Audiomind/src/components/transcript/RealtimeTranscript.test.tsx)

## Current Speaker Flow Summary

1. Deepgram speaker labels are normalized early in `ai-service` by `normalize_deepgram_speaker_label(...)` and then folded into `SPEAKER_n` labels in both the streaming adapter and the pipeline normalization step.
2. The batch adapter currently emits segment maps with a single `speaker` field and does not retain a separate raw/provider speaker field.
3. `pipeline.py` applies an additional canonical speaker re-labeling pass over transcript segments before the final output is used downstream.
4. The AI-service transcript response still exposes `transcripts` as the readable row list, while canonical/raw separation is handled by the transcript canonicalizer / persisted transcript path introduced in 7Q.
5. `ProcessingService` builds readable transcript rows by sorting on timestamps, deduplicating, and collapsing fragments, then passes those rows to TXT/CSV exports and DOCX preview generation.
6. `MeetingReportDocxGenerator` renders the transcript evidence appendix directly from `report.rawTranscriptRows()`.
7. The realtime FE transcript UI renders speaker labels from the `speaker` field on each `TranscriptSegment`, with `RealtimeTranscript` using `normalizeSpeaker(...)` and `TranscriptDisplay` using `normalizeSpeakerBadge(...)`.
8. `App.tsx` merges hydrated/live transcript segments for display and uses `mergeTranscriptSegmentsForDisplay(...)` after hydration or stop, which means the FE already performs a separate display-only merge layer.

## Compatibility Findings

- Existing DTOs, FE transcript components, and report builders already depend on a `speaker` field. The first 7S PR should not rename or remove that field.
- For stabilized user-facing rows, `speaker` can remain the stable display speaker to preserve backward compatibility.
- Provider/raw speaker must be preserved separately, using a top-level field when safe, such as `providerSpeaker` or `originalSpeaker`, or an existing metadata/sidecar payload when top-level schema changes are risky.
- Speaker stabilization metadata should include `speakerStabilizationVersion` and `speakerStats` without forcing a migration unless the existing payload cannot safely carry the data.
- Raw export should keep using raw/provider speaker data or bypass stabilized rows so the stabilizer does not rewrite audit/debug output.

## Current Problem Shape

- Speaker labels can jump across many labels within a single meeting because the current flow preserves provider speaker identity too literally once it is mapped into `SPEAKER_n` labels.
- The current adapter/pipeline path does not preserve raw/provider speaker and stable display speaker as separate concepts.
- Readable transcript export and DOCX preview are still driven by row-level speaker strings, so unstable diarization bleeds directly into user-visible output.
- The FE display path normalizes speaker badges, but it does not rebuild a stable speaker map or fix speaker islands caused by backend diarization drift.
- Raw export is intentionally allowed to remain noisy and overlapping, so the stabilization work must avoid rewriting the raw contract.
- A FE-only speaker stabilization layer would leave readable TXT export and DOCX preview noisy, so it is not sufficient as the Phase 7S source of truth.

## Evidence By Area

### Deepgram mapping

- `normalize_deepgram_speaker_label(...)` in `stt_adapter.py` converts numeric or `SPEAKER_`-style inputs into normalized labels early.
- `_extract_speaker(...)`, `_speaker_from_words(...)`, and the batch segmentation helpers all rely on that normalized label.
- `pipeline.py` then assigns a second canonical `SPEAKER_n` mapping over the transcript segment list.

### Saved transcript rows

- `ProcessingService` reads saved rows from the job-state / persisted transcript source and emits `speaker` directly into `MeetingReportData.RawTranscriptRow`.
- `buildRawTranscriptRows(...)` is a passthrough of the saved speaker value.
- `buildReadableTranscriptRows(...)` sorts by `start_time`, `end_time`, `speaker`, and text before deduplication and fragment collapsing.

### DOCX / export

- `generateMeetingTranscriptTxt(...)` uses the row speaker string verbatim in `Speaker: text` output.
- `generateMeetingTranscriptCsv(...)` writes the row speaker string into the CSV `speaker` column.
- `MeetingReportDocxGenerator` renders `row.speaker()` directly in the transcript evidence appendix.

### FE meeting detail / realtime display

- `RealtimeTranscript.tsx` renders `normalizeSpeaker(segment.speaker, 'SPEAKER_1')`.
- `TranscriptDisplay.tsx` renders `normalizeSpeakerBadge(segment.speaker)`.
- `App.tsx` derives display segments from hydrated/live transcript rows and already has a display-only merge helper, but no speaker stabilization layer.

## Risks Observed

- Speaker stabilization done too early could corrupt the raw/audit transcript path.
- Speaker stabilization done only in FE would leave TXT/DOCX exports noisy.
- Rewriting the 7Q canonicalizer would add unnecessary risk because 7Q already owns raw/canonical transcript normalization and should remain untouched.
- Any stabilization merge that crosses large time gaps could incorrectly join unrelated turns.
- Merging every short segment would hide genuine speaker changes. Short speaker island merge needs explicit guards for duration, surrounding gap, same surrounding speaker, fragment-like text, and maximum combined turn length.
- Automatically rerunning Gemini because the speaker stabilization version changes would broaden 7S into analysis cache invalidation work. That policy should stay deferred to 7U.

## Audit Conclusion

The current system has enough structure to add a dedicated speaker stabilization layer, but it is not yet separated from raw/provider speaker handling. The cleanest next step is a post-STT, pre-display/export layer that preserves provider/raw speaker, produces a stable display speaker map, and feeds readable transcript / DOCX preview / FE display without changing the 7Q canonical transcript contract.

Implementation position:

- The backend should be the source of truth after Deepgram/raw transcript rows are assembled and before readable/export/UI surfaces consume display rows.
- 7S should not be implemented as FE-only cleanup.
- 7S should not rewrite the 7Q canonicalizer.
- Existing FE merge logic may remain as a fallback, but should consume stable backend rows when present.

Data contract decision:

- Keep `speaker` in the first PR.
- Use `speaker` as the stable display speaker for user-facing stabilized rows if that is the least disruptive DTO path.
- Preserve provider/raw speaker in `providerSpeaker`, `originalSpeaker`, or metadata/sidecar fields.
- Add `speakerStabilizationVersion` and `speakerStats` to the row metadata or report metadata.

Short speaker island decision:

- Do not merge every short segment.
- Merge an island only when duration is at or below `SPEAKER_ISLAND_MAX_SECONDS`, gaps on both sides are at or below `SPEAKER_MAX_GAP_SECONDS`, the surrounding speaker is the same on both sides, text looks like a fragment/split artifact, and the combined turn stays within `SPEAKER_MAX_MERGED_TURN_SECONDS`.
- Do not merge when the island looks like an independent turn, has clear terminal punctuation, sits across a large gap, or would create an overly long display turn.

Configuration additions to carry into implementation:

- `SPEAKER_MAX_MERGED_TURN_SECONDS=20.0`
- `SPEAKER_STABILIZATION_DRY_RUN=false`
- `SPEAKER_STABILIZATION_LOG_STATS=true`

Gemini/cache boundary:

- 7S should not automatically rerun Gemini when `speakerStabilizationVersion` changes.
- Analysis cache/hash invalidation belongs to 7U.
- 7S should only make readable/export/UI speaker labels more stable and record metadata for later cache decisions.

## Recommended Implementation Order

1. Add a dedicated speaker stabilization layer after Deepgram diarization output and before readable/export surfaces.
2. Preserve raw/provider speaker in the transcript payload alongside the stable display speaker.
3. Route readable transcript rows, DOCX evidence preview, and meeting detail UI to the stabilized display speaker.
4. Keep raw transcript export untouched.
5. Add tests for speaker jumps, tiny fragment merge, large-gap non-merge, and raw preservation.

## Measurable Acceptance Criteria

- `vn.mp3` has a low stable speaker count, ideally 1-2 if the sample is single-speaker audio.
- `en.mp3` has a stable speaker count that is clearly lower than its raw/provider speaker count.
- Readable TXT export uses stable display speaker labels.
- DOCX preview uses the same stable display speaker labels as readable TXT.
- Raw export uses raw/provider speaker values or at least is not rewritten by the stabilizer.
- FE meeting detail shows the same stable speaker labels as readable export.
- `speakerStats` includes `rawSpeakerCount`, `stableSpeakerCount`, `mergedIslandCount`, `mergedTinyFragmentCount`, and `stabilizationVersion`.
- No Whisper/Ollama/pyannote path is added.
- No real `.env` file is changed.

## Implementation Warnings

- Do not create a migration or database change if existing transcript/report metadata can carry the new stabilization metadata safely.
- Do not change the canonical transcript version/hash in 7S unless it is truly required and documented.
- If canonical hash/version changes are needed, defer to 7U or ask for user confirmation because that crosses into analysis cache invalidation policy.

## Out of Scope

- No Whisper/Ollama/pyannote reintroduction.
- No rewrite of the 7Q canonical transcript pipeline.
- No Gemini rerun policy change.
- No ownership/export gate change.
- No Docker cleanup or compose changes.
