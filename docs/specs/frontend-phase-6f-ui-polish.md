# Phase 6F — Frontend UI Polish + Demo Hardening

## Goal

Polish the AudioMind frontend after core features are complete.

Current completed features:
- Upload language mode
- Upload transcript readability
- Upload transcript grouping
- Gemini structured analysis for upload
- Realtime stopped Gemini analysis
- IT term highlighting for upload + realtime

Phase 6F is UI polish only.

## Scope

### Do

- Improve visual hierarchy.
- Improve spacing and layout.
- Polish upload result view.
- Polish realtime result view.
- Polish analysis panel.
- Improve loading, empty, and error states.
- Improve transcript scroll areas.
- Make IT term highlighting visually consistent.
- Make UI demo-ready on laptop screen sizes.
- Keep existing business logic unchanged.
- Add or update frontend tests if needed.

### Do not

- Do not change backend.
- Do not change API contracts.
- Do not change STT/Deepgram.
- Do not change Gemini prompt.
- Do not change DB.
- Do not implement major new features.
- Do not remove existing upload/realtime behavior.

## Current UI Areas To Improve

### 1. Upload Area

Current:
- Upload flow works.
- Upload language mode works.
- Upload transcript grouping works.
- IT terms highlight in transcript.

Improve:
- File input and upload button spacing.
- Upload language selector visual consistency.
- Loading/disabled states.
- Result layout after upload.
- Clear separation between transcript and analysis.

### 2. Transcript Display

Current:
- Transcript renders as speaker/timestamp cards.
- Upload grouping improves readability.
- IT terms are highlighted.

Improve:
- Better max height and scroll behavior.
- Better spacing between cards.
- Speaker badge consistency.
- Timestamp style less intrusive.
- Highlight color subtle and readable.
- Long transcript should not break layout.

### 3. Realtime Area

Current:
- Realtime recording works.
- Realtime transcript renders.
- IT term highlighting works.
- Realtime stopped Gemini analysis appears after stop.

Improve:
- Start/stop state clarity.
- Connection/recording status visibility.
- Realtime transcript panel stability.
- Analysis loading state after stop.
- Empty/error states.

### 4. Analysis Panel

Current sections:
- Summary
- Keywords
- Technical Terms
- Pain Points
- Action Items
- Domain mode

Improve:
- Section titles consistency.
- Keyword chips.
- Technical term cards.
- Pain point severity badge.
- Action item list styling.
- Empty state styling.
- Loading and error state styling.
- Domain mode display.

## Suggested Components

If useful, polish or introduce:
- AnalysisPanel
- AnalysisSection
- KeywordChips
- TechnicalTermCard
- PainPointCard
- EmptyState
- LoadingState
- ErrorState

Keep refactor minimal.

## Design Guidelines

- Keep UI simple and readable.
- Avoid large redesign.
- Avoid adding new app flow.
- Use consistent spacing.
- Keep transcript and analysis side-by-side or clearly separated where possible.
- Preserve accessibility basics.
- Highlight should not overpower transcript text.

Current frontend structure to keep in mind:
- [FE-Audiomind/src/App.tsx](FE-Audiomind/src/App.tsx) still uses a mix of screen-level layout and inline styles for upload and realtime views.
- [FE-Audiomind/src/components/TranscriptDisplay.tsx](FE-Audiomind/src/components/TranscriptDisplay.tsx) and [FE-Audiomind/src/components/RealtimeTranscript.tsx](FE-Audiomind/src/components/RealtimeTranscript.tsx) already own transcript presentation.
- [FE-Audiomind/src/components/FeatureAnalysis.tsx](FE-Audiomind/src/components/FeatureAnalysis.tsx) is still a dense analysis surface with many inline sections.
- [FE-Audiomind/src/components/FeatureMindmap.tsx](FE-Audiomind/src/components/FeatureMindmap.tsx) is a secondary view that should stay visually consistent with the rest of the app.
- [FE-Audiomind/src/components/HighlightedTranscriptText.tsx](FE-Audiomind/src/components/HighlightedTranscriptText.tsx) and transcript CSS files already set the baseline for term highlighting, so any polish should keep that subtle and readable.

## Testing Plan

Run:

npm --prefix FE-Audiomind run test
npm --prefix FE-Audiomind run build
git diff --check

Add or update tests for:
- Upload transcript still renders.
- Realtime transcript still renders.
- Highlighted terms still render.
- Analysis sections still render.
- Loading state renders.
- Empty state renders.
- Error state renders if implemented.

## Manual Test Plan

### Upload Vietnamese IT

Use vn.mp3 or similar Vietnamese IT audio.

Expected:
- Transcript is readable.
- Vietnamese IT terms are highlighted.
- Upload Gemini analysis appears.
- Layout does not break.

### Realtime English AI

Record:

Anthropic says AI agent is one thing. OpenAI says AI agents are different. These are the biggest AI labs. It is not the same.

Expected:
- AI terms highlight correctly.
- `it` is not falsely highlighted.
- Stop recording works.
- Realtime Gemini analysis appears after stop.

### Negative / Normal Transcript

Use a non-IT sentence.

Expected:
- No weird over-highlighting.
- UI remains clean.

## Acceptance Criteria

- UI looks demo-ready.
- Upload flow still works.
- Realtime flow still works.
- Gemini analysis still works.
- IT term highlighting still works.
- No backend/API changes.
- FE tests pass.
- FE build passes.

## Out of Scope

- Backend changes
- API contract changes
- Gemini prompt changes
- STT/Deepgram quality changes
- DB changes
- Dynamic dictionary from Gemini
- User-editable dictionary
- Export feature
- Search/filter transcript

## Handoff Notes

- Keep the work primarily presentational.
- Prefer small layout and style adjustments over component rewrites.
- Preserve the current transcript and analysis flow.
- If a new component is introduced, keep it narrowly scoped and testable.

Validation after doc only:

git diff -- docs/specs/frontend-phase-6f-ui-polish.md
git diff --check
git status --short --branch

Do not commit.
Do not implement code.
