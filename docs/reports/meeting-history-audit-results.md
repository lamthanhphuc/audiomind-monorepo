# Meeting History Audit Results

## Scope
- Branch: feature/meeting-history-retrieval-spec
- Target phase: 7K-pre - Meeting History: Transcript & Analysis Retrieval
- Status: audit only, no implementation

## Method
- Used CodeGraph context for the transcript/analysis storage surface.
- Used targeted file reads for backend controllers, models, migrations, and FE screens.
- The workspace did not expose the exact `codegraph query` / `codegraph affected` commands requested, so the audit was completed with targeted reads instead.

## Answers to the audit questions

1. Data location: meeting metadata is in the meeting-service `meeting` table/entity, transcript and analysis are in ai-service tables, and live job state is cached in Redis by processing-service.
2. Transcript storage: ai-service stores transcript rows in `transcripts`; realtime also stores fragments in `transcript_fragments` with checkpoints in `transcript_checkpoints`.
3. Analysis storage: ai-service stores structured analysis in `analysis`; processing-service can also keep a job-state result cache in Redis.
4. Realtime vs upload: both eventually rely on ai-service persistence for transcript/analysis, but upload uses batch processing while realtime uses websocket finalization and fragment storage.
5. Current list API: meeting-service already exposes owner-scoped recent meetings through `GET /meetings`.
6. Current detail API: meeting-service exposes `GET /meetings/{id}` and the legacy `/api/v1/meetings/{id}` path also exists.
7. Transcript API: processing-service exposes `GET /processing/{meetingId}/transcript` and `GET /processing/transcript/{jobId}`; ai-service also exposes its own transcript read path.
8. Analysis API: processing-service exposes `GET /processing/{meetingId}/analysis`; ai-service also exposes `/api/meeting/{meetingId}/analysis`.
9. 404 behavior: the current processing-service analysis path is not a pure 404-only not-ready API; it commonly returns JSON state and can also throw failure responses for specific guarded cases. History flow should not depend on lazy-trigger behavior.
10. Current FE screens: upload, realtime, analysis, files, and subjects exist.
11. Upload result: yes, upload already renders transcript and analysis together in the analysis feature view.
12. Realtime result: yes, realtime already renders transcript and post-stop analysis in the realtime dashboard scene.
13. Dashboard/history: the sidebar contains demo list screens, but they are static and not a real backend-powered meeting history experience.
14. Old meeting route: no dedicated archived meeting route is wired in the FE today.
15. Missing API: the FE still needs a coherent history list plus detail experience that reads existing transcript and analysis instead of rebuilding them.
16. Missing detail API: metadata detail exists, but the FE does not yet present a unified detail page for archived meetings.
17. Missing history page: yes, this is the key gap.
18. Missing detail page: yes, this is also required for the phase.
19. Loading/error/empty states: these are required for transcript, analysis, and history list views.
20. Ownership/auth: both meeting-service and processing-service enforce owner or authorization checks; the new history UI must preserve that model.
21. Analysis incomplete risk: high. Archived detail must show processing or missing states rather than assuming analysis exists.
22. Transcript exists but analysis failed: this must be handled as a valid state where transcript is visible and analysis is non-blocking.
23. Realtime storage differs: yes, realtime fragments/checkpoints are separate from batch transcript rows, so the detail view should normalize the display model.
24. Old data missing fields: older rows may lack newer metadata such as language or original file name, so the detail view should tolerate missing metadata.
25. Pagination/search/filter: not required for the first pass, though recent-meetings pagination may be useful later.
26. Contract/client drift: yes, the current meeting OpenAPI file is stale relative to the runtime controller surface and should be treated carefully if the history feature touches generated client code.
27. Security: user ownership must remain enforced so a user can only see their own archived meetings.

## Audit summary
- The backend already stores enough data for meeting history retrieval.
- Main implementation risk: the current analysis read path mixes read behavior with live lazy-trigger behavior, which is unsafe for archive/detail navigation.
- Recommended first implementation decision: split or guard read-only analysis retrieval before wiring the FE history/detail screen.
- The main product gap is still wiring: there is no archive/history FE, and the static dashboard list screens do not yet use backend data.
- The static dashboard screens can be reused visually, but they must be wired to real backend meeting data for this phase.
- Pagination, search, delete, and export are out of scope for MVP.
- The safest implementation direction is to build a read-only history/detail UX on top of the existing storage and owner-scoped reads, while keeping live analysis polling behavior separate.
