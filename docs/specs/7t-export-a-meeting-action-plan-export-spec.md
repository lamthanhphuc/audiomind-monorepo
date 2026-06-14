# Phase 7T-Export-A - Meeting Action Plan Export

Status: SPEC-ONLY

Branch: `docs/7t-qa-f6-start-resume-preroll-mic-sensitivity-spec`

Date: 2026-06-11

This document is a spec and implementation plan only. It does not implement production code.

External docs verification completed against official Apache POI docs:

- Apache POI XWPF quick guide: https://poi.apache.org/components/document/quick-guide-xwpf.html
- Apache POI `XWPFDocument` API: https://poi.apache.org/apidocs/dev/org/apache/poi/xwpf/usermodel/XWPFDocument.html

Key external findings:

- Apache POI XWPF supports read/write access to core `.docx` document parts.
- `XWPFDocument` is the high-level `.docx` document class already used by the repo.
- XWPF is sufficient for the MVP action plan table; complex Word styling should stay out of scope.

## 1. Problem Statement

Users need an exportable implementation/action plan from saved meeting analysis plus transcript evidence. The export should be readable and shareable, but it must not re-run Gemini or mutate the meeting. Search-A should provide reusable transcript evidence, while F8 should provide stable action item fields.

Risks to solve:

- Export must use saved analysis and saved transcript evidence only.
- Export must not call Gemini at export time.
- Missing analysis/evidence must have predictable behavior.
- The action plan export must remain owner-scoped and safe to download.
- Logs must not contain transcript text, prompt text, Gemini response text, keys, secrets, or Authorization headers.

## 2. Current Implementation Audit

Files and symbols inspected:

| Area | File/symbol | Finding |
| ---- | ----------- | ------- |
| Existing report spec | `docs/specs/meeting-report-export.md` | Earlier 7O spec already chose DOCX report export using saved transcript and saved analysis only, no STT/Gemini reprocessing. |
| Report endpoint | `ProcessingController.exportReport` | `GET /processing/{meetingId}/report?format=docx`; requires principal; rejects non-docx; returns DOCX content type, attachment filename `meeting-{id}-report.docx`, and content length. |
| Report service | `ProcessingService.generateMeetingReportDocx` | Fetches accessible meeting, loads saved transcript payload for export, stabilizes readable rows, extracts state analysis, falls back to cache-only saved analysis for report, assembles report data, and calls DOCX generator. Throws 404 only when both transcript and analysis are missing. |
| Report data model | `MeetingReportData` | Contains meeting metadata, business summary, keywords, technical terms, decisions, action items, risks, blockers, next steps, questions, raw transcript preview rows, analyzed highlights, analysis metadata, and analysis availability. |
| DOCX generator | `MeetingReportDocxGenerator.generate` | Uses `XWPFDocument` to write title, metadata table, summary, keywords, technical terms, key decisions, action items, risks/blockers, next steps, analyzed highlights table, analysis metadata, and transcript evidence preview appendix. |
| Action item extraction | `ProcessingService.extractReportActionItems` | Reads `businessActionItems`, then `action_items`, then `actionItems`; extracts `task`, `owner`, `dueDate`/`deadline`, and `evidence`; dedupes by task. No priority/status/evidenceKeywords/evidenceQuote yet. |
| Highlight extraction | `ProcessingService.buildAnalyzedHighlights` | Builds rows from summary, decisions, action items, risks, blockers, questions, and next steps, capped by `MAX_REPORT_HIGHLIGHT_ROWS`. |
| Analysis DTO | `ai-service/app/schemas.py::AnalysisResponse`, FE `AiAnalysis` | Saved analysis supports summary, keywords, structured terms/pain points, rich action items, decisions, risks, blockers, questions, owners/deadlines, impacts, metadata, and retry/status fields. |
| Processing wrapper DTO | `processing-service/controller/dto/AnalysisResponse.java` | Returns `meetingId` and arbitrary `Map<String,Object> data`; additive action-plan fields are compatible. |
| Meeting metadata | `ProcessingService.fetchAccessibleMeeting`, `MeetingServiceClient.getMeetingById` | Processing-service validates ownership by calling meeting-service with the caller Authorization header. |
| Frontend export helper | `FE-Audiomind/src/services/api.ts::downloadMeetingReport` | Fetches `/processing/{meetingId}/report?format=docx`, parses attachment filename, returns Blob and filename. |
| Frontend export UI | `MeetingHistoryScene.tsx::handleExport` | Existing detail header has `Export report` button, disabled until transcript is ready. |
| Existing tests | `ProcessingControllerReportTest`, `ProcessingServiceTest`, FE `api.test.ts` | Controller tests verify report content type/attachment headers and unsupported format. Service tests cover appendix/highlights, transcript-only when analysis missing, stable speaker preview, canonical preview, cache-only analysis fallback, stale metadata, forbidden access, not found when transcript and analysis missing, and preview limits. |

## 3. Chosen Direction

Options considered:

| Option | Summary | Benefits | Risks |
| ------ | ------- | -------- | ----- |
| JSON/Markdown export only | Return action plan preview as JSON/Markdown. | Simple, easy to test, useful fallback. | Less user-friendly for sharing; not enough for requested DOCX deliverable. |
| DOCX action plan export | Dedicated DOCX action plan with action table and evidence. | Matches existing Apache POI infrastructure and user need. | Requires careful generator tests and formatting restraint. |
| PDF export | Generate PDF directly or from DOCX. | Shareable fixed format. | More dependencies and rendering complexity; not needed for MVP. |

Recommended MVP: DOCX action plan export plus JSON preview/fallback.

Rationale:

- The repo already has a working DOCX report generator using Apache POI.
- A JSON preview endpoint is useful for FE and automated tests.
- A dedicated action-plan endpoint avoids breaking the existing general meeting report.
- Export-A can reuse existing auth, meeting metadata, transcript payload, and saved-analysis extraction.
- Export-A should add a dedicated `MeetingActionPlanDocxGenerator`; do not heavily modify `MeetingReportDocxGenerator`.
- Existing `/processing/{meetingId}/report` behavior must remain unchanged.
- `/processing/{meetingId}/action-plan` is a real FE-facing JSON preview API, not a debug-only endpoint.

## 4. Analysis Source Decision

Product decision: Export-A uses saved analysis only.

Required behavior:

- Read saved analysis from job state or cache-only saved analysis helpers only.
- Existing saved/cache-only compatible analysis payloads may be used if they already exist.
- Older analysis payloads must remain readable through compatibility extraction.
- Do not call `getAnalysisInternal` with `allowLazyTrigger=true` for export.
- Do not call `/processing/{meetingId}/analysis` if that path can lazy-trigger analysis.
- Do not call Gemini during export.
- Do not call lazy analysis during export.
- Do not call STT, Whisper, Ollama, `process/start`, or any endpoint that can create missing analysis/transcript data.
- Missing saved analysis returns 409 `ANALYSIS_REQUIRED`.
- Do not export an empty action plan when analysis is missing.
- If analysis is stale/cache-only and metadata exists, include repo-compatible metadata such as `analysisSource`, `cacheOnly`, and `stale` in the JSON preview and DOCX metadata section.

Existing general report export can keep its current behavior. Export-A is a new action-plan workflow and must not change `/processing/{meetingId}/report`.

## 5. Export Data Model

Proposed backend DTO/record:

```json
{
  "meeting": {
    "meetingId": 123,
    "title": "Meeting title",
    "createdAt": "2026-06-11T00:00:00Z",
    "language": "vi",
    "status": "completed",
    "originalFileName": "meeting.webm",
    "ownerUserId": "11"
  },
  "summary": "Saved analysis summary",
  "domainMode": "it",
  "actionItems": [
    {
      "task": "Scale workers",
      "owner": null,
      "deadline": null,
      "priority": "high",
      "status": "open",
      "evidenceKeywords": ["worker", "queue"],
      "evidenceQuote": null,
      "evidence": {
        "evidenceId": "meeting-123-segment-4-worker",
        "segmentId": "meeting-123-start-12.300-speaker_1",
        "speaker": "Speaker 1",
        "startTime": 12.3,
        "endTime": 18.7,
        "text": "short transcript quote",
        "contextBefore": [],
        "contextAfter": []
      }
    }
  ],
  "painPoints": [
    {
      "title": "Queue delay",
      "severity": "high",
      "evidence": "saved evidence"
    }
  ],
  "risks": ["risk"],
  "blockers": ["blocker"],
  "generatedAt": "2026-06-11T00:00:00Z",
  "note": null,
  "analysisMetadata": {
    "provider": "gemini",
    "model": "gemini-2.5-flash",
    "promptVersion": "string",
    "schemaVersion": "string",
    "analysisSource": "saved|cache_only",
    "cacheOnly": false,
    "stale": false,
    "canonicalTranscriptHash": "optional",
    "canonicalTranscriptVersion": "optional"
  }
}
```

DOCX sections:

1. Title: `Meeting Action Plan`
2. Meeting metadata
3. Summary
4. Action plan table with task, owner, deadline, priority, status, evidence quote/context
5. Pain points and risks/blockers
6. Evidence appendix or "No transcript evidence available"
7. Analysis metadata
8. Generated timestamp

## 6. API Proposal

Recommended endpoints:

```http
GET /processing/{meetingId}/action-plan
GET /processing/{meetingId}/action-plan/export?format=docx
```

Behavior:

- `/action-plan` is a real FE-facing JSON preview API using saved analysis and saved transcript evidence.
- `/action-plan` must use the same builder/data contract as DOCX export.
- `/action-plan` must not call Gemini, lazy analysis, STT, Whisper, Ollama, or process/start paths.
- `/action-plan` must be deterministic and safe for FE state checks.
- `/action-plan/export?format=docx` returns a DOCX attachment.
- `format=json` may be accepted as an alias for preview if useful, but separate preview/export paths are clearer.
- Unsupported export formats return 400.
- Missing or inaccessible meeting follows existing 401/403/404 behavior.

Content type and filename:

- DOCX: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- Filename: `meeting-{meetingId}-action-plan.docx`
- JSON preview: `application/json`

## 7. Export Behavior

Data rules:

- Use saved analysis only.
- Use saved transcript/search evidence only.
- Do not call Gemini during export.
- Do not call STT during export.
- Do not trigger lazy analysis from `/analysis`.
- Do not use `getAnalysisInternal(..., allowLazyTrigger=true)`.
- Prefer read-only saved analysis/cached analysis helpers.
- Saved/cache-only compatible analysis payloads are allowed when they already exist.
- Use Search-A evidence service for `evidenceKeywords` when present.
- If F8 `evidenceQuote` is present, verify/augment with Search-A when possible but do not require a Gemini call.
- Use a dedicated `MeetingActionPlanDocxGenerator`.
- Keep `MeetingReportDocxGenerator` and existing general report export behavior unchanged except for shared helper extraction if truly needed and low-risk.

Missing analysis:

- Return 409 with repo-compatible error code/message such as `ANALYSIS_REQUIRED`.
- Do not silently produce a Gemini fallback.
- Do not trigger analysis to create a missing payload.
- Existing general report may still allow transcript-only output; Export-A action plan should require saved analysis because its core object is action items.

Missing evidence:

- Export the action item with `"No transcript evidence available"`.
- JSON preview should include `evidence=null` or an empty evidence array.
- Do not fail the export solely because evidence search has no hits.

Evidence resolution algorithm:

1. Use F8 `evidenceKeywords` with the Search-A internal helper.
2. If no `evidenceKeywords` exist, derive a safe short query from task keywords by removing stop words, punctuation, and very short tokens.
3. Prefer verified Search-A evidence over all model-provided evidence text.
4. If no verified evidence is found, optionally include F8 `evidenceQuote` or `evidence` as an unverified note, clearly distinct from verified transcript evidence.
5. If no verified or unverified evidence exists, use `"No transcript evidence available."`

Search-A integration rules:

- Export-A should call the Search-A helper directly inside processing-service, not the HTTP endpoint.
- Export-A should pass an already-loaded transcript payload when possible so source selection remains consistent and avoids duplicate downstream calls.
- Missing Search-A matches must not fail export.

No action items:

- If saved analysis exists but contains no action items, return 200.
- JSON preview returns `actionItems=[]` with a clear note such as `"No action items available in saved analysis"`.
- DOCX includes a clear "No action items available in saved analysis" row/paragraph.
- Do not return 409 for no action items. 409 is only for missing required saved analysis.

Unicode:

- Preserve Vietnamese and technical terms in Java `String` values.
- Add tests with Vietnamese text and special characters.

Security:

- Require principal at controller.
- Validate meeting access before reading analysis/transcript.
- Do not expose Authorization headers downstream in logs.
- Do not include user secrets in filenames or document metadata.

## 8. Implementation Slices

### Export-A-1 - DTO/action plan builder tests

- Add `MeetingActionPlanData` records or equivalent.
- Add a builder in processing-service that accepts meeting metadata, saved analysis payload, and optional Search-A evidence resolver.
- Unit-test action item extraction with `businessActionItems`, `action_items`, and legacy `actionItems`.
- Include priority/status/evidenceKeywords support and legacy/unverified evidenceQuote/evidence compatibility.
- Return 409 `ANALYSIS_REQUIRED` before building when saved analysis is missing.
- Return 200 with `actionItems=[]` plus a clear note when saved analysis exists but contains no action items.
- Include stale/cache-only metadata when present and repo-compatible.

### Export-A-2 - DOCX generator tests

- Add a focused `MeetingActionPlanDocxGenerator`.
- Do not heavily modify `MeetingReportDocxGenerator`.
- Keep DOCX formatting simple: headings, metadata table, action plan table, evidence appendix.
- Test non-empty byte output and content extracted from DOCX where existing test style allows.

### Export-A-3 - API endpoint/download tests

- Add controller tests for JSON preview, DOCX content type/filename, unsupported format, missing analysis 409, unauthorized/forbidden meeting, and repeated export.
- Add JSON preview tests proving it uses the same builder/data contract as DOCX export and does not call Gemini/lazy analysis/STT.
- Add service tests proving no lazy analysis, Gemini, STT, Whisper, Ollama, or process/start path is called.
- Add tests proving existing `/processing/{meetingId}/report` behavior remains unchanged.

### Export-A-4 - FE export button/download

- Add FE API helper `downloadMeetingActionPlan(meetingId, 'docx')`.
- Add a lightweight `Export action plan` button near existing `Export report`.
- Disable only when meeting is missing or saved analysis is not completed. Transcript can be missing; export should still work with evidence fallback if analysis exists.
- Keep existing report export unchanged.

### Export-A-5 - Integration with Search-A evidence

- Use Search-A service helper to resolve action item `evidenceKeywords`.
- If Search-A is not implemented yet, builder should accept no evidence resolver and produce fallback evidence text.
- Do not invoke Gemini or any external LLM.
- Follow the evidence resolution algorithm in this spec.

## 9. Test Plan

Backend tests:

- Normal DOCX export with meeting metadata, summary, action items, evidence, and generated timestamp.
- JSON preview shape and deterministic output from the same builder as DOCX export.
- Missing analysis returns 409 `ANALYSIS_REQUIRED`.
- No action items returns 200 JSON with `actionItems=[]` and a clear note, and exports a valid "no action items" document.
- Existing stale/cache-only compatible analysis payload exports successfully with metadata included where repo-compatible.
- Older analysis payloads remain readable through compatibility extraction.
- No evidence exports a valid fallback note.
- Long action item list is capped or paginated according to builder limits.
- Vietnamese/special characters survive in JSON and DOCX.
- Unauthorized meeting returns 401/403 as appropriate.
- Unknown meeting returns 404.
- Repeated export is deterministic and does not mutate analysis/transcript state.
- Content type and filename are correct.
- No secret/log leakage.
- No Gemini/lazy analysis call is made during export.
- No STT, Whisper, Ollama, process/start, or lazy-trigger path is called during export.
- Existing general report export tests remain green and behavior unchanged.

Frontend tests:

- API helper builds `/processing/{meetingId}/action-plan/export?format=docx`.
- API helper can fetch `/processing/{meetingId}/action-plan` for FE preview/state checks.
- Blob download uses attachment filename fallback.
- Button disabled/enabled states match saved analysis availability.
- Error message renders for 409 missing analysis.

Manual checks:

- Export a meeting with rich F8 action items.
- Export a meeting with legacy string-only action items.
- Export a Vietnamese meeting with evidence.
- Export with missing transcript evidence.

## 10. Logging Plan

Log:

- `event=ACTION_PLAN_EXPORT_REQUEST`
- `traceId`, `requestId`, `meetingId`
- export format
- action item count
- evidence count
- analysis status/source
- file size for DOCX
- duration

Do not log:

- Transcript text or context snippets.
- Prompt text.
- Raw Gemini response.
- API keys, Authorization headers, env secrets.
- Full query text from evidence search.

## 11. Acceptance Criteria

- Authenticated users can download a DOCX action plan for their own meeting.
- JSON preview is available for the same action-plan data.
- JSON preview is FE-facing, deterministic, and uses the same builder/data contract as DOCX export.
- Export uses saved analysis and saved transcript/search evidence only.
- Export never calls Gemini, lazy analysis, STT, Whisper, Ollama, or process/start paths.
- Missing analysis returns 409 `ANALYSIS_REQUIRED` or a repo-compatible equivalent.
- Existing saved/cache-only compatible analysis payloads can be exported without triggering analysis.
- Saved analysis with no action items returns 200 with an empty action plan and clear note.
- Missing evidence does not fail export.
- Export uses a dedicated `MeetingActionPlanDocxGenerator`.
- Existing general meeting report export remains unchanged.
- Logs are metadata-only and secret-safe.
- F6 and F7 behavior remains unchanged.

## 12. Non-goals

- No Gemini call at export time.
- No PDF in MVP.
- No report template editor.
- No large DB migration.
- No vector/embedding evidence resolver.
- No billing/admin/upload validation changes.
- No production implementation in this spec task.

## 13. Future Work, Not Blocking MVP

- Decide later whether PDF should be added after DOCX usage is validated.
- Decide later whether action-plan templates or styling controls are worth adding.
