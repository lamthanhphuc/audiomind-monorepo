# IT Term Highlighting

## Goal
Highlight IT/domain terms inside upload and realtime transcripts using a static frontend dictionary, without backend/Gemini/STT changes.

## Current Problem
- Transcripts contain technical terms like WebSocket, JWT, Docker, API, database, deployment.
- These terms are not visually emphasized.
- Realtime transcript should remain fast.
- Upload transcript should remain readable after Phase 6C grouping.
- Gemini analysis already extracts terms after completion, but transcript highlighting should work instantly and locally.

Current FE implementation snapshot:
- Upload transcript text is rendered in `TranscriptDisplay` via `segment.text` inside `.transcript-display__text`.
- Realtime transcript text is rendered in `RealtimeTranscript` via `segment.text` and currently supports keyword emphasis through HTML injection.
- Upload display grouping is currently display-only (`groupUploadTranscriptSegmentsForDisplay`) and does not mutate source data.
- Realtime render path is performance-sensitive due to continuous updates and scroll behavior.

## Chosen Scope
FE-only:
- Upload transcript highlighting
- Realtime transcript highlighting
- Shared dictionary
- Shared utility
- Shared component
- Tests

Out of first version:
- No backend persistence
- No Gemini dynamic terms
- No per-segment Gemini calls
- No DB/API contract change

## Options Considered

1. Gemini-generated dynamic terms
Pros:
- Context-aware
Cons:
- Slow, token cost, not suitable for realtime segment render
Decision:
- Out of scope for 6E

2. Backend-generated highlights
Pros:
- Centralized
Cons:
- Requires API/storage changes
Decision:
- Out of scope for 6E

3. FE static dictionary highlighting
Pros:
- Fast, stable, demo-friendly, FE-only
Cons:
- Less context-aware
Decision:
- Chosen for 6E

## Chosen Architecture

Preferred files:
- FE-Audiomind/src/constants/itTerms.ts
- FE-Audiomind/src/utils/highlightTerms.ts
- FE-Audiomind/src/components/HighlightedTranscriptText.tsx
- FE-Audiomind/src/components/HighlightedTranscriptText.test.tsx
- FE-Audiomind/src/utils/highlightTerms.test.ts

Integration:
- TranscriptDisplay uses HighlightedTranscriptText for upload segment text.
- RealtimeTranscript uses HighlightedTranscriptText for realtime segment text.
- FeatureAnalysis should not be changed in this phase unless analysis proves a tiny shared style is safe.
- App-level data/state should not be changed unless necessary.

Current component-level findings:
- Upload and realtime can reuse one shared text-highlighting component because both render plain transcript text content nodes.
- Upload grouping remains safe because grouping runs before rendering and only transforms displayed segment text blocks; highlighting is an additional render layer.
- Realtime currently uses dangerouslySetInnerHTML for keyword highlighting in a legacy path.
- Phase 6E transcript highlighting must migrate to safe React-node rendering via HighlightedTranscriptText.
- If highlightKeywords remains needed, it should use the same safe React-node rendering path or be disabled for transcript text in this phase.
- After Phase 6E, transcript text rendering must not depend on HTML string injection.
- Do not keep any HTML-string injection path for transcript highlighting.
- FeatureAnalysis remains separate and should not be redesigned.

## Dictionary Plan

Core default terms:

API
REST API
JWT
Docker
Kubernetes
CI/CD
WebSocket
database
database migration
migration
latency
endpoint
repository
authentication
authorization
microservice
cache
deployment
frontend
backend
container
pipeline
unit test
integration test
GitHub Actions
OpenAPI
schema
contract
WebSocket latency

Ambiguous terms to be cautious with:

test
log
bug
error
build
server
client
request
response
branch
commit
merge
token
session

Add aliases if useful:
- web socket -> WebSocket
- ci cd -> CI/CD
- db -> database
- auth -> authentication
- repo -> repository

Clarify:
- Dictionary should be centralized.
- Terms should have canonical label and aliases if useful.
- Do not hardcode dictionary inside components.
- Ambiguous terms should be excluded from default v1 highlighting, or only highlighted when part of longer phrases.
- Avoid over-highlighting because it reduces readability.

## Matching Rules

Define:
- Case-insensitive matching.
- Longest term wins.
- No overlapping highlights.
- Prefer phrase terms over single generic words.
- Preserve original text exactly.
- Preserve original punctuation and spacing.
- Do not break punctuation or spacing during render splitting.
- Do not mutate input text.
- Do not throw on empty text.
- Do not highlight inside larger unrelated words.
- Do not highlight inside URLs or emails when easy to detect.
- Escape regex special characters.
- Support terms with special characters such as CI/CD.
- Prefer simple safe word-boundary logic; document limitations with symbols and Vietnamese text.
- If matching is uncertain, prefer not highlighting over false positives.

Examples:
Input:
Tôi đang test WebSocket latency và JWT authentication.

Highlighted:
WebSocket
latency
JWT
authentication

Input:
The REST API endpoint uses JWT authentication.

Expected:
REST API should win over API.
endpoint should highlight.
JWT should highlight.
authentication should highlight.

## Rendering Plan

Use:
- React nodes, not raw HTML.
- No dangerouslySetInnerHTML.
- mark or span with className:
  - it-term-highlight
- Add accessible title/aria-label only if it does not make screen readers noisy.
- Keep normal text unchanged when no match.

Suggested component API:
HighlightedTranscriptText({
  text,
  terms = DEFAULT_IT_TERMS,
  enabled = true
})

If disabled or no match:
- render plain text.

Realtime legacy note:
- Existing highlightKeywords behavior should be routed through the same safe React-node path if retained.
- If this is not feasible in Phase 6E scope, keep highlightKeywords disabled for transcript text rather than using HTML injection.
- Transcript text rendering after this phase must not depend on dangerouslySetInnerHTML.
- The `.keyword-highlight` class may remain only when used by safe React-node rendering, or as a reusable CSS class not tied to HTML injection.

## MVP Implementation Decision

- Create centralized dictionary.
- Create safe matcher utility.
- Create HighlightedTranscriptText component.
- Wire TranscriptDisplay and RealtimeTranscript to use it.
- Preferred implementation: HighlightedTranscriptText owns transcript text rendering for IT terms.
- Preferred implementation: matcher returns text/highlight parts, and React renders those parts.
- Use React nodes only.
- No raw HTML injection is used.
- No backend/Gemini/STT/API/DB changes.
- No dynamic Gemini terms in this phase.
- Keep style subtle.

## Performance Plan

Realtime is sensitive:
- Keep dictionary small.
- Precompile matcher if useful.
- Use useMemo inside HighlightedTranscriptText or in utility call if needed.
- Avoid rebuilding expensive regex on every segment render when possible.
- Do not call Gemini or network API.

## UI Plan

Upload transcript:
- highlight inside transcript segment cards.
- preserve Phase 6C grouping.
- do not alter timestamp/speaker badge.

Realtime transcript:
- highlight inside live/hydrated transcript rows.
- do not change row grouping/merge behavior.
- no extra badges in this phase unless minimal.

CSS:
- subtle background highlight.
- readable in light UI.
- should not overpower speaker/timestamp.
- no large redesign.

Suggested style location:
- Add highlight class in component-level stylesheet(s) used by transcript renderers or a shared transcript text style file if introduced.
- Keep existing `.keyword-highlight` behavior untouched unless explicitly migrated in a later phase.

## Data Safety

Clarify:
- Highlighting is display-only.
- Original transcript text remains unchanged.
- Gemini analysis still uses original transcript.
- Export/copy behavior remains unchanged unless implementation explicitly changes it.
- Copy/export text must remain identical to transcript source text.
- No API contract or DB change.

## Tech Debt Included In Scope

Include:
- Centralize IT dictionary.
- Shared highlight utility.
- Shared HighlightedTranscriptText component.
- Safe regex escaping helper.
- Longest-term/no-overlap matching.
- Tests for upload and realtime render paths.
- Avoid duplicate highlight logic in multiple components.
- Avoid dangerous HTML rendering.
- Add small CSS class for highlight.

## Tech Debt Out Of Scope

Exclude:
- Dynamic Gemini terms.
- User-editable dictionary.
- Backend term extraction.
- Persisting highlights.
- Analysis panel redesign.
- Search/filter transcript.
- STT/Deepgram/diarization improvements.
- Multi-language quality fixes.
- Deepgram paragraphs/utterances.
- Realtime segment grouping changes.
- Upload transcript grouping changes.

## Implementation Plan For Later

Do not implement now, only plan:

1. Create dictionary file.
2. Create highlight utility:
   - escape term regex
   - find matches
   - sort by position
   - resolve overlap
   - return text/highlight parts
3. Create HighlightedTranscriptText component.
4. Add styling.
5. Wire to TranscriptDisplay.
6. Wire to RealtimeTranscript.
7. Add tests.
8. Run FE validation.
9. Manual test upload + realtime.

## Testing Plan

Utility tests:
- highlights exact IT term.
- case-insensitive matching.
- longest term wins: REST API before API.
- no overlapping highlights.
- special chars: CI/CD.
- Vietnamese sentence with English IT terms.
- English sentence with IT terms.
- no match returns plain text part.
- empty text safe.
- original text unchanged.
- does not highlight API inside unrelated longer word.

Component tests:
- HighlightedTranscriptText renders mark/span for IT terms.
- no dangerouslySetInnerHTML.
- preserves text order.
- disabled mode renders plain text.
- upload TranscriptDisplay renders highlighted terms.
- realtime RealtimeTranscript renders highlighted terms.
- realtime render path still passes existing tests.

Regression tests:
- upload transcript grouping still works.
- realtime transcript still displays normal rows.
- FeatureAnalysis remains unaffected.
- upload/realtime Gemini analysis UI still works.

## Manual Test Plan

Upload:
- upload an audio/file containing:
  WebSocket latency, JWT authentication, Docker deployment, database migration.
Expected:
- terms are highlighted in transcript cards.
- grouping still readable.
- analysis panel still works.

Realtime:
- record:
  I am testing WebSocket latency, Docker deployment, JWT authentication, and database migration.
Expected:
- terms highlight live/realtime transcript.
- stop recording still works.
- realtime stopped Gemini analysis still appears.
- no lag/crash.

Negative:
- record normal non-IT sentence.
Expected:
- no weird highlights.
- transcript remains normal.

## Acceptance Criteria

- Upload transcript highlights IT terms.
- Realtime transcript highlights IT terms.
- Highlighting is FE-only.
- No backend/API/DB changes.
- No Gemini per-segment calls.
- No dangerous HTML rendering.
- Terms are matched case-insensitively.
- Longest/no-overlap matching works.
- Existing transcript grouping and realtime rendering still work.
- FE tests and build pass.

## Risks / Known Limitations

Include:
- Static dictionary may miss terms.
- Some STT misrecognitions may not highlight.
- Some ambiguous terms like "test" or "log" may highlight too often.
- Over-highlighting can reduce readability.
- Dynamic/contextual terms can be considered in a later phase using Gemini output after stop/upload completion.
