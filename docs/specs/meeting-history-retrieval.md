# 7K-pre — Meeting History & Detail

## 1. Status
- SPEC-ONLY
- Branch: feature/meeting-history-retrieval-spec
- Date: 2026-05-28
- No runtime changes in this branch

## 2. Background
- This phase comes before the optional Advanced vi+en / Multi STT Optimization Spike because it is a product/demo retrieval feature, not an STT quality change.
- The realtime analysis guard work already established that analysis should be reused when it already exists, and that repeated lazy-trigger spam must be avoided.
- The product needs a stable way to revisit older meetings, transcripts, and saved analysis without reprocessing audio.
- This is especially important for demo flow: users should be able to return to prior meetings and inspect outcomes without rerunning STT or Gemini.

## 3. Goals
- User can list previous meetings and recordings.
- User can open saved transcript data.
- User can open saved analysis data.
- Avoid rerunning analysis when a stored result already exists.
- Show clear states for processing, completed, failed, and missing analysis.
- Keep upload and realtime retrieval behavior consistent.

## 4. Non-goals
- No STT model optimization.
- No multi-language routing redesign.
- No analysis prompt rewrite.
- No large database redesign unless a blocking gap is proven.
- No auth redesign.
- No contract-breaking change unless the read path cannot be represented safely otherwise.

## 5. Current System Audit

### Backend inventory
| Area | Current file/path | Current behavior | Gap |
| ---- | ----------------- | ---------------- | --- |
| Meeting catalog / history | [demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java), [demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/service/MeetingService.java](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/service/MeetingService.java) | Authenticated owner-scoped create, get-by-id, and recent-meetings read endpoints already exist for the runtime entity model. | There is no FE history view wired to this API, and no composite detail experience for archived meetings. |
| Legacy meeting API | [demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/interfaces/http/MeetingV1Controller.java](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/interfaces/http/MeetingV1Controller.java) | Old `/api/v1/meetings` endpoints exist for create/get/result update. | This API shape is stale compared with the current runtime model and does not cover transcript/analysis retrieval. |
| Transcript read path | [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java), [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java) | `GET /processing/{meetingId}/transcript` and `GET /processing/transcript/{jobId}` return persisted transcript data or fallback AI-service transcript data. | The same endpoint family is used for live retrieval and history, but the read path is not yet presented as a history feature in the FE. |
| Analysis read path | [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java), [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java) | `GET /processing/{meetingId}/analysis` reads job-state, falls back to AI-service, and can lazy-trigger realtime analysis when missing. | History/detail views must avoid unintended lazy-trigger behavior when the goal is only to inspect existing data. |
| Ownership enforcement | [demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java), [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java) | Meeting-service requires `UserPrincipal` for owner-scoped reads; processing-service also checks authorization through meeting-service before returning transcript or analysis. | History endpoints must keep this access model consistent so users only see their own meetings. |

### Frontend inventory
| Area | Current file/path | Current behavior | Gap |
| ---- | ----------------- | ---------------- | --- |
| Upload flow | [FE-Audiomind/src/app/App.tsx](../FE-Audiomind/src/app/App.tsx), [FE-Audiomind/src/components/features/FeatureUpload.tsx](../FE-Audiomind/src/components/features/FeatureUpload.tsx) | Upload runs the existing batch flow and then shows the analysis result screen. | No reusable history browser exists for prior meetings. |
| Realtime flow | [FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx](../FE-Audiomind/src/components/features/RealtimeDashboardScene.tsx), [FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx](../FE-Audiomind/src/components/transcript/RealtimeTranscript.tsx) | Realtime UI already renders transcript and post-stop analysis on the live screen. | The experience is session-oriented, not archive-oriented. |
| Analysis result view | [FE-Audiomind/src/components/features/FeatureAnalysis.tsx](../FE-Audiomind/src/components/features/FeatureAnalysis.tsx) | Upload result view already renders transcript and analysis tabs. | It is not connected to a persistent meeting-history page. |
| Static library screens | [FE-Audiomind/src/components/dashboard/FilesList.tsx](../FE-Audiomind/src/components/dashboard/FilesList.tsx), [FE-Audiomind/src/components/dashboard/SubjectsList.tsx](../FE-Audiomind/src/components/dashboard/SubjectsList.tsx) | These are demo/static screens with hard-coded rows. | They do not reflect real backend history data. |
| Navigation shell | [FE-Audiomind/src/components/dashboard/DashboardLayout.tsx](../FE-Audiomind/src/components/dashboard/DashboardLayout.tsx), [FE-Audiomind/src/main.tsx](../FE-Audiomind/src/main.tsx) | The app is a single-page shell with scene switching, not a routed history/detail experience. | There is no route for an archived meeting detail page. |

### Database / data model inventory
| Data | Current storage | Used by upload | Used by realtime | Gap |
| ---- | --------------- | -------------- | ---------------- | --- |
| Meeting metadata | `meeting` table / `Meeting` entity in meeting-service | Yes | Yes | History listing exists only as backend data, not as a FE feature. |
| Transcript rows | `transcripts` table in ai-service | Yes | Yes | Stored transcript is accessible, but history view is not wired to it. |
| Realtime transcript fragments | `transcript_fragments` and `transcript_checkpoints` in ai-service | No | Yes | Realtime persistence is separate from batch transcript rows and must be normalized for readback. |
| Analysis rows | `analysis` table in ai-service | Yes | Yes | Analysis is persisted, but read paths can still fall back or lazy-trigger in some cases. |
| Job-state cache | Redis-backed `JobStateStore` in processing-service | Yes | Yes | Good for live polling, but not a durable history UX by itself. |

### API inventory
| Endpoint | Method | Current behavior | Needed change |
| -------- | ------ | ---------------- | ------------- |
| `/meetings` | GET | Returns recent meetings for the authenticated owner. | Use this as the history list source for the FE. |
| `/meetings/{id}` | GET | Returns a single meeting entity for the authenticated owner. | Use this as the history detail metadata source. |
| `/processing/{meetingId}/transcript` | GET | Returns transcript rows with owner/auth checks. | Use this as the transcript detail source. |
| `/processing/{meetingId}/analysis` | GET | Returns analysis if present, otherwise can fallback or lazy-trigger realtime analysis. | History/detail mode must not unintentionally create a new analysis job. |
| `/processing/status/{meetingId}` | GET | Returns processing state. | Useful for live sessions, not enough for archive browsing alone. |
| `/api/v1/meetings` | POST | Creates a meeting in the legacy API shape. | Not required for history retrieval, but the contract is stale. |
| `/api/v1/meetings/{id}` | GET | Returns the legacy meeting record. | Does not carry transcript or analysis details. |

## 6. Proposed UX Flow

### History page
- Show a list of previous meetings and recordings.
- Show title, created date, language, source, and current state.
- Allow filtering/search later if needed, but do not require it for MVP.
- Clicking a row opens the meeting detail view.

### Detail page
- Show meeting metadata at the top.
- Show a transcript section with a clear empty/loading/error state.
- Show an analysis section with a clear processing/completed/failed/missing state.
- Keep transcript visible even when analysis is unavailable.
- If analysis already exists, render it directly without rerunning the model.

## 7. Proposed API Plan

The preferred plan is to reuse the current runtime conventions instead of inventing a new surface:

- `GET /meetings` for the owner-scoped history list.
- `GET /meetings/{id}` for meeting metadata.
- `GET /processing/{meetingId}/transcript` for transcript detail.
- `GET /processing/{meetingId}/analysis` for analysis detail.

Important rule:
- The archive/detail UX must read already stored results and must not use the live lazy-trigger branch as a side effect of opening historical data.
- If the existing analysis endpoint cannot cleanly separate read-only history access from live polling, the implementation phase should split those concerns before the FE history screen depends on it.

## Read-only analysis retrieval decision

Implementation must choose one of these paths before the FE history/detail view relies on analysis retrieval:

### Option A - separate read-only endpoint
- Add a read-only endpoint such as `GET /processing/{meetingId}/analysis/saved`, or follow the existing runtime convention for a saved-analysis route.
- This endpoint only reads stored analysis.
- It must not trigger a new Gemini/STT/analysis job.
- The history/detail FE must call this read-only path.
- Live realtime polling remains on its own path.

### Option B - explicit read-only mode on the current endpoint
- Keep the current endpoint shape, but add an explicit read-only mode such as a query param or internal flag.
- History/detail FE must call the read-only mode.
- Live realtime polling continues to use the current live behavior.
- The read-only mode must not fall back into lazy-trigger behavior.

Required behavior for both options:
- If analysis is missing, return a clear state such as missing, processing, or failed.
- Do not loop 404 responses into an implicit trigger path for archive reads.
- Do not create a new job just because a user opened a historical meeting.

## 8. Proposed Implementation Slices

Recommended order:

1. Backend read-only semantics for archived analysis.
2. API/contract/client update if needed.
3. FE history list.
4. FE meeting detail.
5. Manual browser smoke for upload and realtime.

### Slice 1 - Backend read semantics
- Make the history/detail read path explicit and side-effect free.
- Reuse stored meeting metadata, transcript rows, and analysis rows first.
- Preserve live polling behavior separately for realtime sessions.
- Keep owner authorization intact for all reads.

### Slice 2 - Contract/client alignment
- If the FE client generation depends on the meeting contract, align the source contract with the runtime read model.
- Validate contract/client drift before any FE wiring.
- Do not widen the API without a concrete UI consumer.

### Slice 3 - FE history page
- Add a history page or scene backed by the owner-scoped meeting list.
- Add loading, empty, and error states.
- Allow click-through to detail.

### Slice 4 - FE detail page
- Add a meeting detail page or scene that shows metadata, transcript, and analysis.
- Render transcript and analysis with the same component language used in upload/realtime.
- Make missing analysis obvious but non-blocking.

### Slice 5 - Tests and validation
- Add backend tests for list/detail/transcript/analysis read behavior.
- Add FE tests for history list, detail loading, and empty/error states.
- Validate contracts or generated client drift if the contract is touched.
- Verify build and targeted test commands before merging the implementation phase.

## Detail state matrix

| Transcript | Analysis | UI behavior | API behavior |
| ---------- | -------- | ----------- | ------------ |
| exists | completed | show transcript + analysis | read stored data only |
| exists | processing | show transcript + processing analysis state | no rerun |
| exists | failed | show transcript + failed analysis state | optional retry later |
| exists | missing | show transcript + no analysis state | no auto-trigger |
| missing | missing | show empty/error transcript state | no auto-trigger |

## 9. Risk Matrix

| Risk | Impact | Likelihood | Mitigation |
| ---- | ------ | ---------- | ---------- |
| Data not persisted consistently | History entries may open with missing transcript or analysis. | Medium | Read the canonical storage layer first and show missing-state UI. |
| Analysis still in progress | User may open a meeting before analysis is complete. | High | Show a processing state and avoid rerunning if a stored result already exists. |
| Old records missing analysis | Archived meetings may only have transcript data. | Medium | Transcript must remain visible even when analysis is absent. |
| Realtime and upload transcript storage differ | FE may show different shapes for similar user actions. | High | Normalize to one display model in the detail view. |
| Contract/client drift | FE may call stale or incomplete endpoints. | Medium | Align contract generation before wiring a new screen. |
| Authorization leak | User could see another user's meeting history. | High | Keep owner-scoped checks on list and detail reads. |

## 10. Acceptance Criteria

- Spec identifies the current storage, API, and FE gaps.
- The plan does not change STT optimization or analysis generation behavior.
- The plan defines the read-only backend semantics needed for archived meetings.
- The plan defines the FE history and detail UX.
- The plan defines processing, completed, failed, and missing states.
- Upload meeting completion can be followed by opening history and seeing transcript plus analysis if it already completed.
- Realtime meeting completion can be followed by opening history and seeing transcript plus analysis if it already completed.
- Meetings with transcript but missing or failed analysis still open in detail.
- Detail page does not rerun analysis on open.
- Authenticated users do not see other users' meetings.
- FE has loading, empty, and error states for list, transcript, and analysis.
- STT routing, default language, and multi behavior remain unchanged.
- The plan stays spec-only in this branch.

## 11. Validation Plan

Implementation-phase validation should include:

```bash
npm run validate:schema
npm run check:openapi
npm run generate:client
npx tsc --noEmit -p tsconfig.generated.json
git diff --exit-code -- packages/api-clients
npm --prefix FE-Audiomind run build
```

If backend Java files are changed:

```bash
cd demoRecordAUDIOMID
.\mvnw.cmd -B test --no-transfer-progress
```

If Python or ai-service files are changed:

```bash
python -m pytest -q demoRecordAUDIOMID/ai-service/tests
```

Then run targeted backend tests for list/detail/transcript/analysis reads, FE unit tests for history/detail state handling, and manual browser smoke of the history and detail views.

## 12. Open Questions

- Should history combine upload and realtime meetings in one list view?
- Should the user be able to delete old meetings?
- Should the user be able to rerun analysis from the detail page?
- Is pagination needed for MVP or can we start with recent meetings only?
- Do we need a dedicated read-only analysis endpoint for archived detail, or can the existing endpoint be made side-effect free for that path?
