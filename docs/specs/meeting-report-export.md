# 7O — Meeting Report Export

## 1. Status

- SPEC-ONLY
- Branch: `feature/meeting-report-export-spec`
- Date: 2026-05-30
- No runtime changes in this branch

## 2. Background

- After 7K-pre Meeting History & Detail
- After 7M Gemini Business Analysis Optimization
- After 7N Meeting Management UX + Duplicate Upload Guard
- Users need an exportable meeting report for company/business use
- The report must use saved transcript plus saved analysis only; it must not reprocess data

## 3. Goals

- Export meeting report as `.docx` in the MVP
- Include meeting metadata
- Include business analysis summary
- Include decisions, action items, risks, blockers, and next steps
- Include a bounded transcript evidence preview appendix
- Keep export owner-scoped
- Do not call STT or Gemini during export

## 4. Non-goals

- No STT optimization
- No Gemini schema rewrite
- No realtime pause/resume change
- No duplicate upload behavior change
- No PDF export in MVP unless trivial
- No manual rerun analysis
- No report template editor
- No full raw transcript cleanup or readability reconstruction in 7O
- No full raw transcript `.txt` or `.csv` export in 7O

## 5. Current system audit

### Backend inventory

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Meeting metadata source | `demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/entity/Meeting.java` and `.../controller/MeetingController.java` | Meeting records store id, title, audioPath, originalFileName, ownerUserId, createdAt, language, status, fileSize | No report export endpoint or report DTO in meeting-service |
| Transcript read path | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java` and `.../service/ProcessingService.java` | `GET /processing/{meetingId}/transcript` returns saved transcript rows; read path enforces auth and owner access via meeting-service lookup | No dedicated report assembly path |
| Saved analysis read path | `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java` and `.../service/ProcessingService.java` | `GET /processing/{meetingId}/analysis/saved` returns saved analysis; `GET /processing/{meetingId}/analysis` may lazily trigger realtime analysis if needed | Report export must use read-only saved analysis only |
| Transcript persistence | `demoRecordAUDIOMID/ai-service/app/models.py` and `.../app/schemas.py` | Transcript rows and segments carry speaker, start_time, end_time, text | No report-shaped DTO for export-ready rows |
| Analysis persistence | `demoRecordAUDIOMID/ai-service/app/models.py`, `.../app/schemas.py`, `.../app/pipeline.py` | Saved analysis includes summary, keywords, technical_terms, action_items, businessActionItems, keyDecisions, risks, blockers, questions, deadlines, owners, nextSteps, businessImpact, customerImpact, technicalImpact, confidence, prompt/schema metadata | No report DTO that merges transcript evidence and business analysis into one export payload |

### Frontend inventory

| Area | File/path | Current behavior | Gap |
| ---- | --------- | ---------------- | --- |
| Meeting history/detail | `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx` | Loads meeting detail, transcript, and saved analysis; renders transcript via `TranscriptDisplay` and analysis via `AnalysisPanel` | No export button and no download flow |
| Analysis detail view | `FE-Audiomind/src/components/features/FeatureAnalysis.tsx` | Shows transcript and analysis for a meeting-facing analysis view | No report-specific UI or export action |
| API service | `FE-Audiomind/src/services/api.ts` | Wraps meeting, transcript, analysis, and processing endpoints | No report export client helper |
| Data normalizers | `FE-Audiomind/src/types/index.ts` | Normalizes business analysis fields and transcript segments for UI rendering | No report-specific formatting for raw vs cleaned transcript tables |

### Data inventory

| Data | Current storage/read path | Needed for report | Gap |
| ---- | ------------------------- | ----------------- | --- |
| Meeting metadata | `meeting-service` meeting entity and `GET /meetings/{id}` | Title, created date, language, status, owner, original file name | Sufficient for report header, but must be assembled into report DTO |
| Raw transcript | `processing-service` transcript endpoint; `ai-service` transcript rows with speaker/start/end/text | Preserve original evidence in a raw transcript table | No report renderer or export table exists |
| Saved analysis | `processing-service` saved analysis endpoint; `ai-service` analysis persistence | Use saved business summary and structured items only | No report renderer that maps business fields into sections |
| Transcript evidence preview | Not stored as a separate report entity today | Show a short, bounded appendix of saved transcript evidence | No canonical preview row model exists yet |

### API inventory

| Endpoint | Method | Current behavior | Needed change |
| -------- | ------ | ---------------- | ------------- |
| `/meetings/{id}` | `GET` | Returns meeting metadata to authenticated owner | May be reused by report generator |
| `/processing/{meetingId}/transcript` | `GET` | Returns saved transcript rows | May be reused by report generator |
| `/processing/{meetingId}/analysis` | `GET` | Returns analysis and may lazily trigger realtime analysis | Report export must not use this path if it can trigger new analysis |
| `/processing/{meetingId}/analysis/saved` | `GET` | Returns saved analysis only | Preferred read path for export |
| `/meetings/{id}/report?format=docx` | `GET` | Does not exist | New owner-scoped report download endpoint |

## 6. Report structure

MVP report sections:

1. Cover / title
2. Meeting metadata
3. Executive summary
4. Key decisions
5. Action items
6. Risks and blockers
7. Next steps
8. Transcript evidence preview appendix
10. Analysis metadata

## 7. Transcript evidence preview appendix

Purpose:
- Preserve a short slice of original transcript evidence for the business report
- Keep the appendix bounded so the DOCX stays readable

Columns:

| # | Start time | End time | Speaker | Transcript evidence |
| - | ---------- | -------- | ------- | -------------- |

Rules:
- Use original transcript text
- Keep speaker labels if available
- Keep timestamps if available
- If timestamp is missing, leave blank or show `N/A`
- Keep only a short, bounded evidence preview
- Do not call Gemini or STT to regenerate or clean transcript text
- Do not try to reconstruct a "clean" transcript in 7O

## 9. Proposed API plan

MVP endpoint:

```txt
GET /meetings/{id}/report?format=docx
```

Optional later:

```txt
GET /meetings/{id}/report/preview
GET /meetings/{id}/report?format=pdf
```

Response:

- `.docx` file download
- `Content-Type` for docx
- `Content-Disposition` with safe filename

Security:

- Owner-scoped access
- User cannot export another user's meeting

## 10. MVP service boundary decision

Recommended MVP:
- Implement report export in `processing-service`
- Reason: processing-service already owns owner-scoped transcript read and saved-analysis read paths
- meeting-service remains the metadata source
- Export must call meeting-service only for metadata or access verification if needed
- Export must not call processing start, STT, Gemini, or lazy analysis paths

Potential endpoint:
- `GET /processing/{meetingId}/report?format=docx`

Alternative:
- `GET /meetings/{id}/report?format=docx` only if routing or gateway convention strongly prefers meeting-service

## 11. Backend implementation direction

- Backend-first report generation
- Reuse existing meeting detail, transcript read, and saved analysis read paths
- Use `.docx` in the MVP
- Repo currently has no DOCX library
- Implementation phase may add `poi-ooxml` only to the service that generates the report, preferably `processing-service`
- Keep the dependency scoped; do not add large unrelated document libraries
- PDF remains later
- The appendix should stay a safe preview, not a transcript cleanup engine

Important:

- Export path must be read-only
- No STT call
- No Gemini call
- No processing start
- No analysis rerun

## 12. FE implementation direction

- Add an `Export report` button in Meeting Detail / History Detail
- Show a loading state while downloading
- Show an error state if report generation fails
- Download the file using browser download flow
- Use a file download helper, not a JSON parser
- Do not trigger analysis or processing
- Disable or explain export if transcript or analysis is missing

## 13. Partial report policy

- If transcript exists but analysis is missing, allow a partial transcript-only export
- Show analysis sections as `N/A` or `Analysis not available`
- Never trigger analysis during export
- If neither transcript nor analysis exists, return a clear error based on existing owner-scoped API convention

## 14. MVP scope

MVP includes:

- DOCX export
- owner-scoped export endpoint
- transcript evidence preview appendix
- business analysis sections
- FE export button
- basic tests
- browser download smoke

## 15. Later scope

Later:

- PDF export
- editable report templates
- report preview UI
- advanced formatting/branding
- export selected sections only
- retry/rerun analysis from export screen
- bilingual report formatting
- chart/analytics report sections
- full raw transcript cleanup/readability reconstruction
- raw transcript `.txt` / `.csv` export

## 16. Risk matrix

| Risk | Impact | Likelihood | Mitigation |
| ---- | ------ | ---------- | ---------- |
| Export accidentally uses `/processing/{id}/analysis` | It may lazily trigger analysis | High | Export must read from `/analysis/saved` only |
| Export triggers STT/Gemini accidentally | Extra cost and wrong behavior | High | Keep report service read-only; add tests and log smoke |
| Raw transcript gets modified | Evidence is no longer trustworthy | High | Keep a separate raw transcript table |
| Cleaned table hallucinates owner/due date | Misleading business report | Medium | Use saved analysis only; leave missing fields blank |
| Old meetings lack timestamps or speakers | Report table may look incomplete | Medium | Show `N/A` fallback |
| Large transcript creates huge DOCX | Slow export or large file | Medium | Keep MVP simple; consider truncation or appendix later |
| User exports another user's meeting | Privacy issue | High | Enforce owner-scoped checks |
| PDF export too complex | Delays MVP | Medium | Keep PDF later |

## 17. Acceptance criteria

- User can export a completed meeting as `.docx`
- Report includes meeting metadata
- Report includes business summary, decisions, action items, risks, blockers, and next steps
- Report includes a short transcript evidence preview appendix, not a cleaned transcript
- Export does not call STT, Gemini, or lazy analysis paths
- Report includes a raw transcript table
- Report includes a cleaned/analyzed transcript table
- Raw transcript table preserves original text
- Cleaned/analyzed table does not invent owner or due date
- Export does not call STT
- Export does not call Gemini
- User cannot export another user's meeting
- FE shows loading and error state for export
- Export logs show report generation only
- Export logs must not contain `processing/start`, `STT`, `Gemini`, `GEMINI`, or `ANALYSIS_TRIGGERED`
- No STT routing/default/multi changes
- No Gemini schema rewrite
- No realtime pause/resume changes

## 18. Validation plan

Implementation phase should run:

- backend tests for owner-scoped report export
- backend tests that export does not call processing, STT, or Gemini
- backend tests that confirm partial report export returns metadata plus raw transcript when analysis is absent
- FE tests for export button, download, and error state
- FE build
- contract/client validation if the API endpoint or headers change
- contract/client validation if API contract changes

Manual browser smoke:

1. Open a completed meeting
2. Click Export Report
3. Download `.docx`
4. Open the file manually
5. Confirm metadata and analysis are present
6. Confirm raw transcript table exists
7. Confirm cleaned/analyzed table exists
8. Check logs: no STT or Gemini activity during export

## 19. Open questions

- Should the final route use processing-service directly or be proxied by a gateway to meeting-service conventions?
- Should PDF be added immediately or later?
- Should cleaned/analyzed transcript rows be generated from saved analysis only, or stored as a separate report DTO later?

## 20. 7O Final Readability Adjustment

- Report metadata should display `Recognition Mode` (meeting language config) and `Detected Transcript Language` (heuristic from saved transcript text).
- `Detected Transcript Language` is report-only and deterministic (`English` / `Vietnamese` / `Mixed` / `Unknown`), without calling STT or Gemini.
- `Appendix A — Raw Transcript` may group consecutive STT fragments into utterance blocks and collapse repeated overlaps for readability while preserving original wording of kept rows (no rewrite/paraphrase).
- STT multi-language optimization (vi+en quality/routing) is explicitly out of scope for 7O.
