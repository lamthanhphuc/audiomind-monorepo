# 7T-QA-F10 - Grouped Action Plan Analysis / Export Spec

Status: SPEC-ONLY

Updated: 2026-06-12

This spec defines the additive `groupedActionPlan` contract for Audiomind saved analysis, FE meeting detail, Search-A evidence matching, and DOCX/action-plan export.

This pass is documentation only. Do not edit Java, TypeScript, Python, tests, environment files, Docker files, browser smoke scripts, or runtime configuration while updating this spec.

## 0. Current Spec Review

CodeGraph was used first to inspect the current analysis/export flow and relevant symbols:

- `AIAnalyzer.prepare_analysis_for_storage`, `_build_gemini_analysis_json_prompt`, `_build_gemini_response_schema`, and action-item normalization in `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py`.
- `AnalysisCacheIdentity` in `demoRecordAUDIOMID/ai-service/app/services/analysis_runs.py`, which already includes prompt/schema versions.
- `MeetingAnalysis` and response schemas in `demoRecordAUDIOMID/ai-service/app/schemas.py`.
- `ProcessingService`, `MeetingActionPlanBuilder`, `MeetingActionPlanDocxGenerator`, and `ProcessingController` in processing-service.
- FE analysis/action-plan consumers in `FE-Audiomind/src/services/api.ts`, `FE-Audiomind/src/types/index.ts`, `FE-Audiomind/src/components/features/MeetingHistoryScene.tsx`, `RealtimeDashboardScene.tsx`, and `AnalysisStatusPanel.tsx`.

Spec comparison:

- F9 already covers Search-A short-query hardening, Export-A evidence confidence, saved-analysis-only export, no export-time Gemini, and the v2 version/downgrade guard.
- ErrorUX-A already has generic export and analysis errors such as `ANALYSIS_REQUIRED`, `EXPORT_ANALYSIS_REQUIRED`, `EXPORT_EVIDENCE_UNAVAILABLE`, and `EXPORT_FAILED`.
- Validation-A already requires owner gates, saved analysis before export, no provider call from export, evidence confidence validation, capped inputs, and early rejection of invalid requests.
- F8/Search/Export integration defines the existing action item compatibility set:
  - `action_items` as the canonical rich backend list.
  - `businessActionItems` as rich FE/report compatibility.
  - `actionItems` as legacy string tasks.
- Export-A currently builds JSON/DOCX action plans from saved analysis and Search-A evidence. The current builder is flat-action-item oriented.

Current gaps:

- No `groupedActionPlan` schema exists.
- No Gemini grouped-plan prompt/schema exists.
- No grouped-plan FE rendering contract exists.
- No grouped-plan DOCX rendering contract exists.
- No tests prevent hallucinated grouped sections, hard-coded Hackathon headings, or verified evidence without Search-A matches.

## 1. Goal

Turn flat action items into a structured implementation plan grouped by natural functional areas, while preserving existing saved analysis fields and export/search behavior.

Required outcomes:

- Add `groupedActionPlan` as an additive saved analysis field.
- Keep `action_items`, `businessActionItems`, and `actionItems` unchanged for backward compatibility.
- Produce a clean, copyable Vietnamese-friendly action plan suitable for teammates or project documents.
- Group work by natural product/business/workflow areas without hard-coding any one domain.
- Avoid invented tasks, owners, deadlines, evidence, or sections not supported by transcript-derived analysis.
- Preserve Search-A and Export-A evidence confidence rules.
- Preserve F9 realtime/audio/fallback, Search-A, Export-A, ErrorUX-A, Validation-A, and Gate-A contracts.
- Keep runtime default as Deepgram STT plus Gemini analysis.
- Keep analysis metadata on `gemini-business-v2` or a later explicitly approved version; never downgrade v2 to v1.

## 2. Non-Goals

- Do not replace or remove `action_items`.
- Do not remove `businessActionItems` or legacy `actionItems`.
- Do not hard-code Hackathon sections or any other domain-specific section names.
- Do not create a full project management tool, kanban workflow, assignment engine, or calendar integration.
- Do not fabricate assignees, owners, deadlines, due dates, priorities, or completion statuses.
- Do not call Gemini during export, DOCX generation, Search-A, or preview rendering.
- Do not treat raw model `evidence`, `evidenceQuote`, or long model text as verified evidence.
- Do not modify F9 realtime/audio/fallback behavior in this phase.
- Do not enable Whisper, Ollama, embeddings, vector search, or PDF export.
- Do not log raw transcript, raw prompt text, raw Gemini responses, provider payloads, secrets, tokens, Authorization headers, device ids, or env secret values.

## 3. Data Contract

Existing fields remain present and readable:

```json
{
  "action_items": [],
  "businessActionItems": [],
  "actionItems": []
}
```

New additive field:

```json
{
  "groupedActionPlan": {
    "version": "grouped-action-plan-v1",
    "language": "vi",
    "intro": "Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:",
    "sections": [
      {
        "id": "section-1",
        "order": 1,
        "title": "Quản lý Người dùng và Đăng ký",
        "summary": "Các việc liên quan đến tài khoản, đăng nhập và đăng ký.",
        "items": [
          {
            "id": "item-1",
            "title": "Thiết lập cơ chế đăng nhập",
            "description": "Triển khai đăng nhập bằng Gmail và cấp tài khoản dựa trên Gmail.",
            "subtasks": [
              {
                "id": "subtask-1",
                "text": "Thêm nút đăng nhập bằng Gmail.",
                "confidence": "SUPPORTED",
                "evidenceKeywords": ["Gmail", "đăng nhập"]
              }
            ],
            "owner": null,
            "deadline": null,
            "priority": "high",
            "status": "open",
            "confidence": "SUPPORTED",
            "evidenceKeywords": ["Gmail", "đăng nhập", "tài khoản"],
            "sourceActionItemIds": ["action-1"]
          }
        ]
      }
    ],
    "notes": [
      {
        "text": "Một số tính năng nên tối ưu cho giao diện mobile.",
        "confidence": "SUPPORTED",
        "evidenceKeywords": ["Mobile", "app", "sinh viên"]
      }
    ]
  }
}
```

Canonical storage rules:

- `groupedActionPlan` is additive and optional on old saved analysis.
- New `gemini-business-v2` or later saved analysis should include `groupedActionPlan` whenever transcript content has enough action-oriented signal.
- `action_items` remains the canonical flat rich action-item list for backend compatibility.
- `businessActionItems` mirrors the rich flat list for FE/report compatibility.
- `actionItems` remains a legacy string list derived from rich task titles.
- `groupedActionPlan.sections[*].items[*].sourceActionItemIds` should link to normalized flat action item ids when a mapping exists. Missing mappings are allowed.
- Do not migrate old saved analysis at read time by calling Gemini. Fallback rendering may be deterministic and local only.

## 4. Field Rules

Top-level `groupedActionPlan`:

- `version` is required. Current value: `grouped-action-plan-v1`.
- `language` is required and must be `vi`, `en`, or `mixed`.
- `intro` is safe user-facing text, max 360 characters.
- `sections` is required and capped at 0-8 sections.
- `notes` is optional and capped at 0-8 notes.

Section:

- `id` is required, stable within one saved analysis payload, and safe for FE keys.
- `order` is required, starts at 1, and determines display order.
- `title` is required when the section has items, max 80 characters.
- `summary` is optional, max 240 characters.
- `items` is required and capped at 0-8 items per section.
- Empty sections after normalization must be dropped unless they carry an explicit no-task note needed for fallback display.

Item:

- `id` is required, stable within one saved analysis payload, and safe for FE keys.
- `title` is required, max 120 characters.
- `description` is optional but recommended, 1-2 short sentences, max 500 characters.
- `subtasks` is optional and capped at 0-8 subtasks.
- `owner` is nullable. Fill only when transcript explicitly supports the owner.
- `deadline` is nullable. Fill only when transcript explicitly supports the deadline.
- `priority` must be `low`, `medium`, `high`, or `null`.
- `status` must be `open`, `in_progress`, `blocked`, or `done`.
- `confidence` must be `SUPPORTED`, `INFERRED`, or `NEEDS_REVIEW`.
- `evidenceKeywords` must contain 1-8 short keyword hints when available. Keywords must not be long quotes.
- `sourceActionItemIds` is optional and capped at 0-8 ids.
  
Status clarification:

- `status=open` is the default extraction/display state for an actionable task.
- `open` does not mean the transcript explicitly said the task is newly assigned.
- Use `in_progress`, `blocked`, or `done` only when the transcript explicitly supports that state.
- Do not infer `done`, `blocked`, owner, or deadline from general discussion.

Subtask:

- `id` is required when present.
- `text` is required, max 180 characters.
- `confidence` follows the same enum as item confidence.
- `evidenceKeywords` is optional and capped at 0-8 short keyword hints.
- Subtasks must not carry separate invented owner/deadline fields in MVP.

Note:

- `text` is required, max 240 characters.
- `confidence` follows the same enum.
- `evidenceKeywords` is optional and capped at 0-8 short keyword hints.
- Notes are for implementation caveats, rollout considerations, or constraints. They are not tasks unless the transcript clearly expresses an action.

## 5. Confidence Rules

Confidence is a semantic support label, not evidence verification.

| Confidence | Meaning | Allowed use |
| --- | --- | --- |
| `SUPPORTED` | Transcript-derived analysis contains clear support for the task/note. | Can be displayed normally. Evidence is still verified only after Search-A match. |
| `INFERRED` | Task is a light synthesis from multiple related statements, with no single direct instruction. | Display with a soft "Suy luận" state. Do not claim verified transcript evidence unless Search-A matches. |
| `NEEDS_REVIEW` | The item may be useful but support is weak or incomplete. | Display with "Cần xác minh" and avoid verified evidence unless Search-A matches. |

Rules:

- Export marks evidence as verified only when Search-A resolves a persisted transcript row.
- `SUPPORTED` alone is not enough to mark evidence verified.
- `INFERRED` and `NEEDS_REVIEW` must remain unverified if Search-A has no match.
- Do not turn every decision, risk, blocker, question, or pain point into a task. A task requires an action to do.
- If support is weak, either move the idea to `notes` with `NEEDS_REVIEW` or drop it.
- Never invent owner/deadline to make the plan look complete.
- Never elevate a note to a task just because it sounds project-related.

## 6. Grouping Algorithm / Prompt Behavior

Gemini should group work by natural domain context from the transcript, not by a fixed taxonomy.

Expected grouping patterns:

- Technical/product meetings: group by module, feature, platform, screen, API, workflow, integration, or workstream.
- Business meetings: group by team, objective, phase, process, customer journey, or operating area.
- Education/project meetings: group by use case, component, screen, actor, assignment phase, or deliverable.
- Mixed meetings: prefer stable workstreams that a teammate can understand without the transcript.
- Unclear or low-signal meetings: use no sections, or one `Công việc chung` section only when there are real tasks.

Hard constraints:

- Do not hard-code Hackathon headings. Hackathon headings are example acceptance fixtures only.
- Do not force a fixed number of sections.
- Do not create empty sections to match an example.
- Preserve proper nouns and technology names such as Gmail, GitHub, SemINA, FPT, Mobile App, and similar transcript-supported terms.
- Keep section titles short, concrete, and document-friendly.

## 7. Gemini Prompt / Schema Requirements

Update the Gemini analysis prompt and structured response schema additively.

Prompt must require:

- Valid JSON only.
- Existing canonical flat `action_items` rich output.
- Existing `businessActionItems` and legacy `actionItems` compatibility output.
- New `groupedActionPlan` object.
- User-facing values in Vietnamese when the transcript is mostly Vietnamese; use `mixed` only when the transcript itself is materially mixed.
- No Markdown inside JSON string fields.
- No tasks outside the transcript-derived discussion.
- No fabricated owner, assignee, deadline, due date, status, or priority.
- No long evidence quotes.
- Evidence hints through `evidenceKeywords` only.
- Natural grouping by domain/workstream, not by the Hackathon example.
- Empty or minimal grouped output when there are too few tasks.

Schema guidance:

- Keep the response schema shallow enough for Gemini structured output.
- Prefer strings, arrays, and simple objects over deeply nested evidence objects.
- Include enum constraints where provider schema support allows; otherwise validate application-side.
- Keep `groupedActionPlan.version` and item/subtask/note `confidence` in schema.
- Keep `sourceActionItemIds` optional.
- Do not add raw transcript quote fields to the new schema.

Logging:

- Log counts and metadata only: section count, item count, subtask count, note count, confidence counts, prompt/schema version, transcript hash prefix, and normalization error codes.
- Do not log prompt text, raw transcript text, full Gemini response text, full grouped plan payload, task bodies, note bodies, evidence keywords, owners, deadlines, or user-specific content.

## 8. Normalization / Fallback

Normalizer requirements:

- Parser must not crash when `groupedActionPlan` is missing, malformed, partially malformed, or over limit.
- Normalize invalid `language` to `mixed` or infer safely from available metadata.
- Normalize invalid `priority` to `null` or `medium` according to existing flat action-item compatibility rules.
- Normalize invalid `status` to `open`.
- Normalize invalid `confidence` to `NEEDS_REVIEW`.
- Trim all strings and drop blank required fields.
- Cap sections, items, subtasks, notes, evidence keywords, and source ids.
- Deduplicate near-identical tasks within and across sections.
- Drop empty sections and empty items.
- Preserve `groupedActionPlan` only if the final normalized shape is valid.

Fallback when grouped plan is missing:

- If saved analysis has flat `action_items`, backend/FE/export may create a deterministic local fallback section:
  - `title`: `Công việc chung`
  - `items`: from normalized flat `action_items`
  - `confidence`: `SUPPORTED` when the flat item has usable evidence keywords; otherwise `NEEDS_REVIEW`
  - `sourceActionItemIds`: mapped from flat item ids if available
- If saved analysis has only legacy `actionItems`, fallback items may be created with `NEEDS_REVIEW` and no verified evidence.
- If saved analysis has no usable action items, FE/export should show a light empty state such as `Chưa có công việc đủ rõ để phân nhóm.`
- Export must not call Gemini to backfill grouped output for old saved analysis.
- Re-analyze is the only user-triggered way to regenerate a first-class grouped plan.

## 9. Evidence Integration

Reuse Search-A and Export-A evidence rules.

Evidence source rules:

- `item.evidenceKeywords`, `subtask.evidenceKeywords`, and `note.evidenceKeywords` are query hints only.
- Verified evidence must come from persisted transcript rows through Search-A matching.
- Do not use model-provided `evidence`, `evidenceQuote`, item text, description text, or note text as verified evidence unless Search-A independently matches the transcript row.
- Weak or wrong evidence becomes unverified.
- No match renders `No transcript evidence available.`
- Evidence confidence gates from F9/Export-A still apply.

Resolution order for export:

1. Use item/subtask `evidenceKeywords` with the internal Search-A helper.
2. If no keywords exist, derive a short safe query from item/subtask title tokens with stop-word removal.
3. Prefer verified Search-A evidence over all model-provided evidence text.
4. If no verified match exists, optionally show an unverified note only when existing Export-A rules allow it.
5. Otherwise show `No transcript evidence available.`

Safety:

- Do not log raw query text, raw transcript text, evidence quote text, or full context snippets.
- Safe logs may include keyword count, result count, confidence bucket, and match/no-match status.
- Cross-meeting evidence is forbidden. Owner and meeting gates must run before evidence resolution.

## 10. FE Requirements

FE meeting detail and report surfaces must support grouped plans additively.

Display:

- Add a section, tab, or panel titled `Công việc theo nhóm` or `Kế hoạch công việc`.
- Render `intro` when present.
- Render sections in `order`.
- Each section shows title and optional summary.
- Items show title, description, priority, status, owner, and deadline when present.
- Subtasks render nested under their parent item.
- Notes render after sections or in a final notes area.

Confidence UI:

- `SUPPORTED`: no badge is required, or show a subtle `Có cơ sở`.
- `INFERRED`: show `Suy luận`.
- `NEEDS_REVIEW`: show `Cần xác minh`.
- Confidence display must not imply verified transcript evidence.

Empty and legacy states:

- Missing `groupedActionPlan` must not crash the UI.
- Old saved analysis should still show existing flat action item UI.
- If fallback grouped display is implemented, label it as derived from existing action items.
- If no grouped or flat tasks exist, show a light empty state.

Behavior:

- Re-analyze completion must refresh saved analysis and grouped plan display.
- Export buttons must not trigger re-analysis.
- FE should keep existing report export and action-plan export behavior working.
- FE should not log raw analysis payloads, task bodies, evidence keywords, transcript text, or provider responses.

## 11. Export / DOCX Requirements

DOCX/report/action-plan export must add a grouped section when data exists:

`CÔNG VIỆC CẦN LÀM THEO NHÓM CHỨC NĂNG`

Render order:

1. Intro.
2. Section heading.
3. Main bullet item.
4. Nested subtasks.
5. Owner, deadline, priority, and status when present.
6. Verified evidence line when Search-A evidence passes confidence gates.
7. `No transcript evidence available.` when no verified evidence exists.
8. Notes at the end of the grouped plan or the relevant section.

Export rules:

- Use saved analysis only.
- Do not call Gemini, lazy analysis, STT, Whisper, Ollama, or process/start paths during export.
- Do not break existing `/report` export or flat action-plan export.
- Existing DOCX action-plan output remains valid if `groupedActionPlan` is absent.
- Missing saved analysis remains `EXPORT_ANALYSIS_REQUIRED`.
- Missing grouped plan with flat action items may render deterministic fallback.
- Missing all action items should produce a valid document with a clear no-action-items message, not a provider call.
- Verified evidence must come only from Search-A over persisted transcript rows.
- Wrong/weak evidence must not appear as verified evidence in DOCX.
- Preserve Vietnamese text, special characters, and proper nouns.

## 12. API / Backward Compatibility

Saved analysis responses must expose, when present:

- `groupedActionPlan`
- `action_items`
- `businessActionItems`
- `actionItems`

Compatibility rules:

- Old saved analysis without `groupedActionPlan` remains readable.
- New analysis writes `gemini-business-v2` metadata unless a later approved version supersedes it.
- If grouped schema changes in a way that affects output semantics, bump `schemaVersion` or include a versioned grouped-plan contract change in the analysis cache identity.
- Manual re-analysis must preserve or produce v2+ and include grouped output when the transcript supports action planning.
- v1 cache results must not satisfy v2 grouped-plan requests.
- Processing-service DTOs may pass `groupedActionPlan` through as arbitrary map data, but typed FE/API contracts should model the new field.
- No API should require clients to stop reading legacy flat action item fields.

## 13. ErrorUX / Validation Integration

Add or reuse ErrorUX-A codes:

| Code | HTTP | Message intent | Retryable | Action |
| --- | --- | --- | --- | --- |
| `GROUPED_ACTION_PLAN_UNAVAILABLE` | 200/409 | Grouped plan is absent or not enough task signal exists. | false | `NONE` |
| `GROUPED_ACTION_PLAN_INVALID` | 500/409 | Saved grouped plan shape is malformed after normalization. | false | `CONTACT_SUPPORT` or `NONE` |
| `GROUPED_ACTION_PLAN_EXPORT_FAILED` | 500 | Grouped plan export failed. | true | `RETRY` |

Validation-A additions:

- Grouped plan export requires saved analysis; no saved analysis remains `EXPORT_ANALYSIS_REQUIRED`.
- Export, preview, and DOCX rendering must not call Gemini or any provider to create grouped data.
- Normalize or reject malformed grouped data before FE/DOCX rendering.
- Cap sections, items, subtasks, notes, evidence keywords, and source ids.
- Owner gate applies before reading analysis, transcript rows, Search-A evidence, or exports.
- Do not treat missing grouped data as a fatal error when old saved analysis has valid flat action items.
- Do not mark evidence verified unless Search-A confidence gates pass.

Gate-A checklist additions:

- Verify grouped Hackathon-like meeting output without hard-coding Hackathon section names.
- Verify non-Hackathon meeting does not use Hackathon headings.
- Verify grouped DOCX section renders and export has no provider call.
- Verify old saved analysis without grouped plan does not crash FE/export.

## 14. Tests

AI service tests:

- Hackathon-like transcript creates natural sections such as:
  - `Quản lý Người dùng và Đăng ký`
  - `Quản lý Cuộc thi và Tổ chức`
  - `Vận hành trong thời gian thi`
  - `Chấm điểm và Xếp hạng`
  - `Kết thúc và Lưu trữ`
- Non-Hackathon transcript does not use Hackathon headings.
- Low-task transcript returns `sections=[]` or a minimal `Công việc chung` section without fabricated tasks.
- Owner/deadline are not invented when absent.
- Invalid Gemini grouped shape normalizes safely.
- Invalid confidence/status/priority values normalize safely.
- Section/item/subtask caps are enforced.
- Duplicate or near-duplicate tasks are deduped.
- `gemini-business-v2` metadata remains present after analysis and re-analysis.
- Legacy `action_items`, `businessActionItems`, and `actionItems` remain present.
- Safe logging tests prove no prompt, raw transcript, raw Gemini response, full grouped payload, task body, note body, evidence keyword text, owner, or deadline is logged.

Processing/export tests:

- Saved grouped plan renders in JSON preview.
- Saved grouped plan renders DOCX section `CÔNG VIỆC CẦN LÀM THEO NHÓM CHỨC NĂNG`.
- Nested subtasks render correctly.
- Missing grouped plan with flat action items renders fallback or safe empty state.
- Missing saved analysis returns `EXPORT_ANALYSIS_REQUIRED`.
- No export-time Gemini, lazy analysis, STT, Whisper, Ollama, or process/start call occurs.
- Evidence is verified only when Search-A match exists.
- Weak/wrong evidence is rejected or unverified.
- Vietnamese and special characters survive JSON and DOCX.
- Existing report export and flat action-plan export remain unchanged.

FE tests:

- Meeting detail renders grouped plan.
- Missing grouped plan does not crash.
- Legacy saved analysis still renders flat action items.
- Re-analyze refreshes grouped plan.
- Export button does not trigger re-analysis.
- Confidence states render as expected.
- Empty grouped plan shows light empty state.
- FE does not log raw analysis/transcript/provider content.

Regression tests:

- Existing `action_items` UI still works.
- Existing `businessActionItems` consumers still work.
- Existing legacy `actionItems` string consumers still work.
- F9 Search-A boundary and Export-A evidence confidence tests still pass.
- ErrorUX-A structured error tests still pass.
- Validation-A no-provider-call tests still pass.
- Gate-A log-safety scan remains clean.

## 15. Acceptance Criteria

- A Hackathon-like meeting returns a clear grouped implementation plan that can be copied to a teammate or project document.
- Hackathon headings are not hard-coded; other domains produce domain-appropriate groupings.
- `action_items`, `businessActionItems`, and `actionItems` remain present and compatible.
- `groupedActionPlan` has a stable `grouped-action-plan-v1` schema.
- FE renders grouped plan cleanly and does not crash on old saved analysis.
- DOCX/action-plan export includes grouped sections when available.
- Export never calls Gemini or lazy analysis.
- Verified evidence is never wrong or based only on raw model quote text.
- Tasks, owners, deadlines, statuses, and priorities are not fabricated.
- Re-analysis remains v2+ and cannot downgrade to v1.
- Relevant AI, processing/export, FE, Search-A, Export-A, ErrorUX-A, and Validation-A tests pass.
- Runtime logs and artifacts contain no raw transcript, raw prompt, raw Gemini response, secrets, tokens, Authorization values, raw audio, device ids, or env secret values.

## 16. Implementation Order Recommendation

F10 must not be marked complete until these F9 gates pass:

0. F9 R1 - Re-analyze v2/cache guard.
1. F9 R5 - Search-A boundary matching.
2. F9 R6 - Export-A evidence confidence.

After those dependencies are green, implement F10 in this order:

1. AI schema/prompt/normalizer for `groupedActionPlan`.
2. AI cache/idempotency update with `analysisFeatureSet=grouped-action-plan-v1`.
3. AI tests for grouped schema, fallback, no hallucination, metadata, cache feature set, and log safety.
4. Processing DTO/parser/action-plan JSON preview support.
5. Processing DOCX action-plan grouped rendering.
6. FE typed contract and meeting detail grouped rendering.
7. FE copyable Markdown/plain-text grouped output.
8. Search-A evidence matching integration for item/subtask evidence.
9. ErrorUX/Validation/Gate-A regression tests.
10. Manual sample meeting check with safe metadata only.

Do not start export rendering before saved analysis normalization is stable.
Do not mark the feature complete until old saved analysis, flat action items, grouped display, copy output, DOCX export, evidence confidence, cache feature set, and v2 metadata all work together.

## 17. Implementation Hardening Addendum

This addendum is mandatory for implementation. It resolves cache, field-name, fallback, export, copy, output-size, dependency, and log-safety ambiguities that can otherwise break F9/F10/Gate-A.

### 17.1 Cache And Schema Identity

`groupedActionPlan` changes analysis output semantics. A saved or cached `gemini-business-v2` payload that lacks `groupedActionPlan` is not equivalent to a grouped-plan-capable analysis result.

Implementation must choose one of these cache/idempotency strategies:

1. Include `analysisFeatureSet=grouped-action-plan-v1` in analysis cache and idempotency identity.
2. Bump `schemaVersion` to a grouped-aware version and require that version for grouped-plan requests.

MVP recommendation:

- Keep `schemaVersion=gemini-business-v2` for compatibility.
- Add `analysisFeatureSet=grouped-action-plan-v1` to cache and idempotency identity.
- Expose `analysisFeatureSet: "grouped-action-plan-v1"` in saved analysis metadata when practical.
- Include `analysisFeatureSet` in safe metadata returned by saved analysis, re-analyze, realtime analysis, and action-plan preview when practical.

Rules:

- Old `gemini-business-v2` cache entries without `groupedActionPlan` must not satisfy a grouped-plan-capable analysis request.
- Re-analyze must produce grouped output when `analysisFeatureSet=grouped-action-plan-v1` is required.
- A grouped cache hit is valid only when transcript hash, canonical transcript version when present, provider, model, prompt version, schema version, analysis input mode, owner identity, and `analysisFeatureSet` match the request identity.
- No `gemini-business-v1` cache or result may satisfy a grouped-plan request.
- Cache-only saved-analysis reads may return old payloads for display, but must clearly behave as old analysis and must not be treated as fulfilling grouped generation.

Required tests:

- Old v2 cache without grouped plan is not reused when grouped feature set is required.
- v2 grouped cache is reused only when transcript hash, promptVersion, schemaVersion, and `analysisFeatureSet` match.
- v1 cache/result never satisfies grouped-plan requests.
- Saved analysis metadata exposes `analysisFeatureSet` when implementation chooses the feature-set strategy.

### 17.2 Canonical Public Field Name

Public saved analysis JSON and FE API responses must use exactly:

- `groupedActionPlan`

Rules:

- Do not emit both `groupedActionPlan` and `grouped_action_plan` in public API responses.
- Internal Python/Java naming may use language conventions only if serialization is stable and the public JSON field remains `groupedActionPlan`.
- FE types and normalizers must read `groupedActionPlan` as canonical.
- An optional dev-only compatibility helper may tolerate `grouped_action_plan` from an internal fixture or legacy debug payload, but it must normalize to `groupedActionPlan` and must not re-emit snake_case publicly.
- If both variants appear in one payload, implementation must either reject the payload as invalid or choose the canonical camelCase value and record a safe normalization warning. The chosen policy must be tested.

Required tests:

- Saved analysis response contains `groupedActionPlan`.
- Saved analysis response does not contain duplicate snake_case/camelCase grouped-plan variants.
- FE accepts canonical `groupedActionPlan`.
- Old saved analysis without `groupedActionPlan` renders safely.

### 17.3 Relationship With Canonical Flat `action_items`

`action_items` remains canonical for machine-readable flat tasks. `groupedActionPlan` is a presentation and work-breakdown layer built from normalized flat tasks and transcript-supported synthesis.

Rules:

- Grouped items should map to `sourceActionItemIds` whenever possible.
- A grouped item with no `sourceActionItemIds` must not be `SUPPORTED` unless deterministic transcript/Search-A support exists.
- If an item is not supported by flat `action_items` or transcript-derived evidence, it must be dropped or marked `NEEDS_REVIEW`.
- Grouped plan must not invent new tasks absent from both canonical flat `action_items` and transcript-derived Search-A evidence.
- A grouped item may split a flat task into subtasks only when the subtasks are directly supported by the flat item text or Search-A evidence.
- A grouped item may combine duplicate/near-duplicate flat tasks, but `sourceActionItemIds` should retain all source ids when available.
- `businessActionItems` and legacy `actionItems` must remain derived from or compatible with the normalized flat task list, not from unverified grouped-only tasks.

Required tests:

- Grouped output fails normalization or downgrades confidence when it adds an unsupported task as `SUPPORTED`.
- Flat `action_items`, `businessActionItems`, and legacy `actionItems` remain present after grouped-plan normalization.
- Grouped items map to flat action item ids when possible.
- Grouped-only inferred items are not treated as verified or canonical flat tasks without evidence.

### 17.4 Missing Grouped Plan Behavior

Missing `groupedActionPlan` is not a fatal error for old saved analysis.

Rules:

- Missing `groupedActionPlan` with flat `action_items` must return 200 and render a deterministic fallback:
  - section title: `Công việc chung`
  - items derived from flat `action_items`
  - confidence from flat item metadata when available, otherwise `NEEDS_REVIEW`
- Missing `groupedActionPlan` with no flat action items must return 200 with a clear empty state:
  - `Chưa có công việc đủ rõ để phân nhóm.`
- `GROUPED_ACTION_PLAN_UNAVAILABLE` should normally be a display state, not a blocking 409.
- Use 409 for grouped plan unavailable only if a future strict endpoint explicitly requires grouped output and cannot accept fallback.
- Export must not call Gemini to fill missing `groupedActionPlan`.
- Re-analyze is the only supported user-triggered path to produce first-class grouped output for old analysis.

Required tests:

- Old saved analysis without grouped plan and with flat items returns grouped fallback 200.
- Old saved analysis without grouped plan and without flat items returns empty-state 200.
- Missing grouped plan does not call Gemini.
- FE and DOCX export do not crash on old saved analysis.

### 17.5 Export Scope

F10 export scope is deliberately narrow.

F10 must update:

1. Action-plan JSON preview endpoint.
2. Action-plan DOCX export.

Rules:

- Existing general meeting report export must remain unchanged unless explicitly implemented and tested in a separate, named scope.
- DOCX action plan must include this section when grouped data or fallback exists:
  - `CÔNG VIỆC CẦN LÀM THEO NHÓM CHỨC NĂNG`
- JSON preview should expose canonical `groupedActionPlan` or deterministic fallback.
- Export must use saved analysis only.
- Export must not trigger Gemini, lazy analysis, STT, Whisper, Ollama, or process/start paths.
- Export must not mark grouped evidence verified without a Search-A persisted transcript match.
- Existing flat action-plan preview/export behavior must keep working.

Required tests:

- Action-plan JSON preview includes grouped plan or deterministic fallback.
- Action-plan DOCX includes grouped section.
- General meeting report export is unchanged unless explicitly implemented and tested.
- No export-time Gemini/lazy analysis call occurs.
- Grouped evidence is verified only after Search-A confidence gates pass.

### 17.6 Copyable Output

FE should provide copyable Markdown or plain-text rendering of `groupedActionPlan`.

Copy output must follow this shape:

```markdown
Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:

### 1. <Tên nhóm chức năng>
* **<Tên công việc>:** <Mô tả>.
  * <Subtask>.
  * <Subtask>.

### 2. <Tên nhóm chức năng>
...
```

Rules:

- Preserve Vietnamese text and proper nouns.
- Do not include unverified evidence as if it were verified.
- Confidence markers may be included only as labels such as `Suy luận` or `Cần xác minh`; they must not imply verified transcript evidence.
- If grouped plan is missing but flat items exist, copy fallback uses `Công việc chung`.
- If no grouped or flat items exist, copy output uses the empty-state text.
- Copy formatting should come from a pure helper where practical so it is easy to test and does not depend on rendered DOM state.

Required tests:

- Copy formatter preserves section order, item text, subtasks, Vietnamese text, and proper nouns.
- Copy formatter uses fallback for old saved analysis.
- Copy formatter does not include unverified evidence as verified evidence.

### 17.7 Long Output Guard

Hard caps:

- Max 8 sections.
- Max 8 items per section.
- Max 8 subtasks per item.
- Max 8 notes.
- Max 8 `evidenceKeywords` per item, subtask, or note.
- Max 8 `sourceActionItemIds` per item.

Rules:

- For long meetings, prioritize high-confidence and high-value tasks.
- Do not list every small conversational detail.
- Prompt must instruct Gemini to summarize and group work, not exhaustively enumerate every minor task.
- Normalizer must cap overlong output deterministically.
- When trimming over-limit output, preserve display order and higher-confidence items first when confidence is available.
- Log only cap counts and normalization codes, not trimmed text.

Required tests:

- Over-limit sections, items, subtasks, notes, keywords, and source ids are capped.
- Overlong grouped output does not crash parser, FE rendering, or DOCX export.
- Prompt/schema tests assert caps are documented in the request to Gemini.

### 17.8 Implementation Dependency

F10 depends on these F9 gates:

- F9 R1 Re-analyze v2/cache guard.
- F9 R5 Search-A boundary matching.
- F9 R6 Export-A evidence confidence.

Rules:

- Do not mark F10 complete until R1/R5/R6 tests pass.
- If F10 is implemented in parallel, grouped plan generation may proceed, but verified grouped evidence must remain unverified until Search-A and Export-A confidence gates pass.
- Gate-A must require F9 R1/R5/R6 before signing off F10 export/evidence.
- If Search-A is temporarily unavailable, grouped preview/export may render tasks with `No transcript evidence available.` but must not call Gemini or trust model quotes.

### 17.9 Log Safety For Grouped Plan

Runtime logs may include:

- section count
- item count
- subtask count
- note count
- confidence counts
- normalization error codes
- feature set
- cache identity decision reason

Runtime logs must not include:

- full `groupedActionPlan` payload
- section titles
- item titles or descriptions
- subtask text
- note text
- `evidenceKeywords`
- owner/deadline values
- raw transcript
- raw prompt
- raw Gemini response
- provider payloads
- secrets, tokens, Authorization values, device ids, or env secret values

Log-safety scan should include runtime/source searches for risky patterns while allowing docs and tests to include intentional sample strings.

### 17.10 Additional Tests To Add To F10

AI service:

- Grouped output includes all legacy flat action fields.
- Old v2 cache without grouped plan is not reused when grouped feature set is required.
- Grouped plan does not produce `SUPPORTED` unsupported new tasks.
- Grouped output caps long sections/items/subtasks.
- Output uses `groupedActionPlan`, not public `grouped_action_plan`.

Processing/export:

- Action-plan JSON preview includes grouped plan/fallback.
- Action-plan DOCX includes grouped section.
- General report export remains unchanged unless explicitly implemented.
- Missing grouped plan with flat items returns fallback 200.
- Missing grouped plan with no items returns empty-state 200.
- No export-time Gemini/lazy analysis occurs.

FE:

- Detail page renders `groupedActionPlan`.
- Detail page renders fallback for old saved analysis.
- Copyable Markdown/plain-text output works.
- Response with duplicate `groupedActionPlan`/`grouped_action_plan` is normalized or rejected according to the chosen policy.
- Grouped plan does not break existing flat action item UI.

Regression:

- F9 R1/R5/R6 tests still pass.
- ErrorUX-A and Validation-A tests still pass.
- Gate-A checklist includes F10 rows.

## 18. Final Output Checklist For This Spec Pass

When this spec pass is complete, report:

1. CodeGraph usage summary.
2. Files read.
3. Spec files changed or created.
4. Summary of the `groupedActionPlan` contract.
5. ErrorUX/Validation additions, if any.
6. Open questions, preferably none.
7. Confirmation that no code, test, env, or Docker files changed.
8. Confirmation that nothing was staged, committed, or pushed.
9. Confirmation that `git add .` was not used.
10. Confirmation that no raw transcript, raw prompt, Gemini response, secret, token, Authorization value, device id, or env secret was printed.

## 19. Open Questions

No blocking questions.

Resolved decisions:

- `groupedActionPlan` is additive and optional for old saved analysis.
- `grouped-action-plan-v1` is the initial grouped schema version.
- Export must use saved analysis only and never call Gemini.
- Search-A over persisted transcript rows remains the only source of verified evidence.
- Hackathon section names are acceptance examples, not a hard-coded taxonomy.
