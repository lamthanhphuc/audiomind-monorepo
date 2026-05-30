# Meeting Report Export Audit Results

## Scope

- Branch: `feature/meeting-report-export-spec`
- Target phase: `7O — Meeting Report Export`
- Status: audit only, no runtime implementation

## Method

- CodeGraph commands used: `codegraph status`, `codegraph context`, `codegraph query` x3
- `codegraph affected` was attempted but returned an error because it needs file arguments
- Targeted reads used on meeting-service, processing-service, ai-service, FE-Audiomind, contracts, and pom files
- No runtime changes were made

## Current meeting data summary

- Meeting metadata is stored in `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/entity/Meeting.java`
- Current fields include `id`, `title`, `audioPath`, `originalFileName`, `ownerUserId`, `createdAt`, `language`, `status`, `fileSize`, plus internal `audioHash` and `deletedAt`
- `MeetingController` and `MeetingService` already enforce owner-scoped meeting access for CRUD actions

## Current transcript read summary

- Transcript rows are exposed by `processing-service` through `GET /processing/{meetingId}/transcript`
- The read path uses `assertMeetingAccess`, which checks authorization and verifies ownership by calling meeting-service
- Transcript data in `ai-service` includes speaker, `start_time`, `end_time`, and `text`
- The frontend normalizes transcript segments and renders them with `TranscriptDisplay`

## Current analysis read summary

- Saved analysis is exposed by `processing-service` through `GET /processing/{meetingId}/analysis/saved`
- The read path is owner-scoped and read-only, while `GET /processing/{meetingId}/analysis` may still lazily trigger analysis in some cases
- `ai-service` analysis schema includes summary, meetingSummary, keywords, technical_terms, action_items, businessActionItems, keyDecisions, risks, blockers, questions, deadlines, owners, nextSteps, businessImpact, customerImpact, technicalImpact, confidence, prompt/schema metadata, transcript hash, and status/source fields
- The frontend already normalizes these fields into `AiAnalysis` for display

## Current FE detail/export summary

- `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx` already loads meeting detail, transcript, and saved analysis together
- That view renders transcript with `TranscriptDisplay` and analysis with `AnalysisPanel`
- `FE-Audiomind/src/components/features/FeatureAnalysis.tsx` also renders transcript plus analysis for a meeting-centric analysis experience
- There is currently no report export button or download flow

## Recommended implementation boundary

- Recommended MVP boundary is `processing-service`
- Reason: it already owns owner-scoped transcript reads and saved-analysis reads
- `meeting-service` remains the meeting metadata and ownership source
- Export must not route through processing start, lazy analysis, STT, or Gemini paths
- The safest export read path is to reuse `GET /processing/{meetingId}/transcript` and `GET /processing/{meetingId}/analysis/saved`

## 7O MVP decision

- 7O ships a business-first DOCX export with a short transcript evidence preview appendix
- 7O does not attempt full transcript cleanup, readability reconstruction, or raw transcript `.txt` / `.csv` export
- 7O does not change STT routing, realtime pause/resume, or duplicate upload behavior
- STT multi/vi+en quality work remains a later phase item

## Report generation gaps

- No report DTO exists that combines meeting metadata, raw transcript rows, and cleaned/analyzed rows
- No endpoint returns a downloadable report document
- No DOCX generator exists in the current Java backend poms
- No `poi-ooxml` dependency is present yet in the backend services
- No frontend helper exists for report download or loading/error states around export
- No test coverage currently asserts that export does not call STT or Gemini because export does not exist yet

## API gaps

- Existing API coverage stops at meeting CRUD and transcript/analysis reads
- No `/meetings/{id}/report` endpoint exists in meeting-service or processing-service
- No `/processing/{meetingId}/report` endpoint exists yet either
- OpenAPI/contracts do not define a report export operation
- `packages/api-clients` do not contain report/download helpers

## Data gaps

- Raw transcript rows exist, but not as a report-oriented evidence preview model
- Cleaned/analyzed transcript rows are out of scope for 7O MVP
- Business analysis fields exist, but there is no mapping rule for turning them into a cleaned transcript export model in 7O
- Owner-scoped export must rely on the same authorization checks used by meeting detail and transcript/analysis reads
- Partial report behavior is now recommended as transcript preview plus business sections marked unavailable when analysis is missing

## Recommended implementation plan

1. Backend report DTO
2. DOCX generator
3. Owner-scoped report endpoint
4. FE export button
5. Tests
6. Browser download smoke

## Open questions / blockers

- `codegraph affected` could not run without file arguments, so dependency impact still needs a follow-up command in implementation planning
- The report route still needs a final convention decision if the gateway prefers meeting-service-style URLs
- DOCX library choice is effectively narrowed to `poi-ooxml` for the report-producing service
- Main risk: accidentally using `/analysis` instead of `/analysis/saved`, which could trigger lazy analysis during export

## Confirmation

- Spec-only
- No runtime changes
- No commit

## 7O Final Scope Clarification

- Report metadata now separates `Recognition Mode` from `Detected Transcript Language`.
- `Detected Transcript Language` is derived from saved transcript text using deterministic heuristics and does not trigger STT/Gemini.
- The appendix is a short transcript evidence preview, not a cleaned transcript or readability reconstruction.
- Later phases may revisit raw transcript cleanup, multilingual quality, and full transcript export formats.
