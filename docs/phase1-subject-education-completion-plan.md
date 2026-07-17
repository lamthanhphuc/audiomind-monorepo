# Phase 1 — Subject Management & Education Analysis Completion Plan

## 1. Scope và non-goals

- **Scope**: hoàn thiện end-to-end FE–BE–AI cho quản lý folder/môn học, gán môn cho meeting, unclassified flow, hiển thị `educationStudy`, evidence navigation.
- **In scope**: cập nhật contracts OpenAPI, generated clients, FE services/types/UI/tests, xác minh BE/AI integration, cập nhật docs.
- **Non-goals**:
  - Không thêm framework state mới (không React Query/SWR/Redux).
  - Không thêm React Router (dự án dùng custom routing).
  - Không làm Git Stage B, không xóa branch/tag.
  - Không redesign lại realtime/upload/STT pipeline đang hoạt động.
  - Không mở rộng `SubjectMeetingResponse` trong Phase 1 (xem §12, §26).

## 2. Verified Git state

### Before plan review

- **Branch**: `feature/phase1-subject-education`
- **Working tree**: clean (không thay đổi chưa commit)
- **Recent commits (top)**:
  - `5525c95 feat(ai): add education study structured analysis`
  - `f09c970 docs: record phase 1 step 6 results`
  - `2ec0915 feat(meetings): support subject assignment and upload subjectId`

### After plan review (documentation-only)

- **Branch**: `feature/phase1-subject-education` (unchanged)
- **Working tree**: `?? docs/phase1-subject-education-completion-plan.md` (plan file untracked)
- **Note**: working tree **không còn clean** cho đến khi plan được commit hoặc bỏ qua theo quy trình docs.

## 3. Verified current implementation

### 3.1 Frontend

- Entry/integration: [`App.tsx`](../FE-Audiomind/src/app/App.tsx)
- Routing: [`studioRouting.ts`](../FE-Audiomind/src/utils/studioRouting.ts), [`useStudioRouteSync.ts`](../FE-Audiomind/src/app/useStudioRouteSync.ts)
- Nav production: [`DashboardLayout.tsx`](../FE-Audiomind/src/components/dashboard/DashboardLayout.tsx)
- Dead/demo sidebar: [`Sidebar.tsx`](../FE-Audiomind/src/components/dashboard/Sidebar.tsx) (không được import trong production)
- API client chính: [`api.ts`](../FE-Audiomind/src/services/api.ts)
- Meeting/analysis types + normalizer: [`types/index.ts`](../FE-Audiomind/src/types/index.ts)
- Analysis scene: [`FeatureAnalysis.tsx`](../FE-Audiomind/src/components/features/FeatureAnalysis.tsx)
- Transcript UI: [`TranscriptDisplay.tsx`](../FE-Audiomind/src/components/transcript/TranscriptDisplay.tsx)
- Existing highlight/jump util theo time-range: [`transcriptJump.ts`](../FE-Audiomind/src/utils/transcriptJump.ts)
- FE test framework/scripts: Vitest/Vite ([`FE-Audiomind/package.json`](../FE-Audiomind/package.json))

### 3.2 Backend (meeting-service)

- Folder controller: [`StudyFolderController.java`](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/StudyFolderController.java)
- Subject controller: [`SubjectController.java`](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/SubjectController.java)
- Meeting create realtime/upload/assign/unclassified: [`MeetingController.java`](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java)
- Ownership/archived validation: [`MeetingService.java`](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/service/MeetingService.java)
- Pagination DTO: [`PageResponse.java`](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/dto/PageResponse.java)
- Subject meeting DTO: [`SubjectMeetingResponse.java`](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/dto/SubjectMeetingResponse.java)

### 3.3 AI service

- Education normalization/schema: [`education_analysis.py`](../demoRecordAUDIOMID/ai-service/app/services/education_analysis.py)
- Analyzer prompt/schema wiring: [`ai_analyzer.py`](../demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py)
- Realtime education fragment scope: [`main.py`](../demoRecordAUDIOMID/ai-service/app/main.py)
- Segment identity helpers: [`segment_identity.py`](../demoRecordAUDIOMID/ai-service/app/services/segment_identity.py)
- Education tests: `test_education_analysis.py`, `test_education_schema.py`, `test_education_realtime_fragments.py`

### 3.4 Contracts/tooling

- Contracts: [`meeting-api.yaml`](../packages/contracts/meeting-api.yaml), [`ai-api.yaml`](../packages/contracts/ai-api.yaml)
- Generated clients: [`packages/api-clients/`](../packages/api-clients/)
- Root scripts verified in [`package.json`](../package.json): `validate:contracts`, `generate:client`, `typecheck:client`, `check:openapi`

## 4. Confirmed gaps

- FE chưa có luồng môn học thực (sidebar/tree/pages/dialogs/services).
- `createRealtimeMeeting` FE chưa nhận/gửi `subjectId`.
- `uploadToMeetingApi` FE chưa gửi `subjectId`.
- `Meeting` type FE chưa có `subjectId`.
- `AiAnalysis` normalizer chưa map `educationStudy`.
- Education UI panel chưa có.
- Evidence navigation hiện tại dựa thời gian, chưa có mapping chuẩn từ `sourceSegmentIds`.
- OpenAPI contracts chưa phản ánh đầy đủ folder/subject/unclassified và `educationStudy` schema tường minh.
- Subject meetings UI fields `duration` / `sourceType` / `transcriptStatus` / `analysisStatus` **không có** trong DTO hiện tại → deferred (§26).

## 5. API contract matrix

| Feature | Method | Path | Request | Response | Owner | Archived | Pagination | FE consumer | Status | Action |
|---|---|---|---|---|---|---|---|---|---|---|
| Folder CRUD/tree | POST/GET/PATCH/DELETE | `/study-folders`, `/study-folders/tree`, `/study-folders/{id}` | DTO/Map | `StudyFolderResponse` / tree | Yes | N/A | No | Sidebar/dialogs | BE DONE | FE + OpenAPI |
| Subject CRUD | POST/GET/PATCH/DELETE | `/subjects`, `/subjects/{id}` | DTO/Map | `SubjectResponse` / `SubjectDetailResponse{subject}` | Yes | Yes (archive) | List: `PageResponse` | Pages/dialogs | BE DONE | FE + OpenAPI |
| Subject meetings | GET | `/subjects/{subjectId}/meetings` | `page,pageSize` | `PageResponse<SubjectMeetingResponse>` | Yes | N/A | Yes | Subject detail | BE DONE | FE (Phương án B UI) |
| Assign subject | PATCH | `/meetings/{meetingId}/subject` | `{subjectId\|null}` | `Meeting` | Yes | Yes | No | Detail/unclassified | BE DONE | FE integrate |
| Unclassified | GET | `/meetings/unclassified` | `search,sort,page,pageSize` | Shape equivalent to `PageResponse<Meeting>`; controller returns `Map.of(items,total,page,pageSize,totalPages)` | Yes | N/A | Yes | Unclassified page | BE DONE | FE + OpenAPI typed equivalent |
| Realtime create | POST | `/meetings/realtime` | `{title,language,subjectId?}` only | map incl. `subjectId` | Yes | Yes | No | Realtime start | BE DONE / FE PARTIAL | FE send `subjectId`; **no `domainMode` in meeting-api** |
| Upload | POST multipart | `/meetings/upload` | `title,file,language,subjectId?` | map incl. `subjectId` | Yes | Yes | No | Upload flow | BE DONE / FE PARTIAL | FE append `subjectId` correctly |
| Saved analysis (FE) | GET | `/processing/{meetingId}/analysis/saved` | query scope optional | stored analysis payload (open/Map JSON) | n/a | n/a | n/a | `getSavedAnalysis` → FeatureAnalysis | PARTIAL | FE normalizer + OpenAPI `educationStudy` |
| Realtime analysis hop | — | see §18 | — | — | — | — | — | Realtime scene | PARTIAL | FE display; not direct FE→ai internal |

### Analysis data hops (không nhầm endpoint)

**Saved/batch path (FE read):**

```text
Frontend (getSavedAnalysis)
  → GET /processing/{meetingId}/analysis/saved
  → processing-service stored analysis payload
  → (origin) ai-service batch/internal analysis during job processing
```

**Realtime path:**

```text
Frontend realtime stream / processing result
  ← WebSocket processing result (analysis in job payload)

Processing-service (server-side)
  → POST /api/internal/realtime-analysis (ai-service internal; FE không gọi trực tiếp)
```

## 6. File impact matrix

| File | Current responsibility | Planned change | Reason | Risk | Tests/verification |
|---|---|---|---|---|---|
| [`meeting-api.yaml`](../packages/contracts/meeting-api.yaml) | Meeting contract baseline | Add folder/subject/unclassified/assign + `subjectId` on create/upload | FE typed clients | Contract drift | `validate:contracts`, `check:openapi` |
| [`ai-api.yaml`](../packages/contracts/ai-api.yaml) | Open `AnalysisResponse` | Add explicit `educationStudy` schema | Document payload | Backward compat | `validate:contracts` |
| [`packages/api-clients/meeting.ts`](../packages/api-clients/meeting.ts) | Generated meeting types | Regenerate only | Contract sync | Drift | `generate:client`, drift check |
| [`packages/api-clients/ai.ts`](../packages/api-clients/ai.ts) | Generated AI types | Regenerate only | Contract sync | Drift | `generate:client`, drift check |
| [`types/index.ts`](../FE-Audiomind/src/types/index.ts) | `Meeting`, `AiAnalysis`, normalizer | Add study/education types; extend `Meeting.subjectId`; map `educationStudy` | FE contract | Legacy break | `types/index.test.ts` |
| [`types/index.test.ts`](../FE-Audiomind/src/types/index.test.ts) | Normalizer tests | Add education cases | Regression guard | — | vitest |
| [`services/api.ts`](../FE-Audiomind/src/services/api.ts) | HTTP helpers | Object-arg `createRealtimeMeeting`/`uploadToMeetingApi` with `subjectId`; add assign/unclassified | Integration | Duplicate upload | `api.test.ts` |
| [`services/api.test.ts`](../FE-Audiomind/src/services/api.test.ts) | API tests | subjectId multipart/realtime; saved analysis | Contract | — | vitest |
| [`services/studyFolders.ts`](../FE-Audiomind/src/services/studyFolders.ts) **NEW** | — | Folder CRUD + tree client | API layer | URL dup | new unit tests |
| [`services/subjects.ts`](../FE-Audiomind/src/services/subjects.ts) **NEW** | — | Subject CRUD + meetings + assign helpers | API layer | Pagination | new unit tests |
| [`utils/studioRouting.ts`](../FE-Audiomind/src/utils/studioRouting.ts) | Scene paths | Add subjects/subjectDetail/unclassified + dynamic parse | Navigation | Reload bugs | `studioRouting.test.ts` |
| [`utils/studioRouting.test.ts`](../FE-Audiomind/src/utils/studioRouting.test.ts) | Routing tests | New path cases | Regression | — | vitest |
| [`app/useStudioRouteSync.ts`](../FE-Audiomind/src/app/useStudioRouteSync.ts) | Popstate sync | Wire new scenes | Navigation | — | routing tests |
| [`app/App.tsx`](../FE-Audiomind/src/app/App.tsx) | Scene switch | Mount new pages; provider wrapper | Integration | Regression | App tests |
| [`app/useRealtimeSession.ts`](../FE-Audiomind/src/app/useRealtimeSession.ts) | Realtime create | Pass `subjectId` to API | Record flow | Mic flow | session tests |
| [`components/dashboard/DashboardLayout.tsx`](../FE-Audiomind/src/components/dashboard/DashboardLayout.tsx) | Production nav | Inject `SubjectSidebarSection` | Replace hard-code gap | Layout | component tests |
| [`components/features/FeatureUpload.tsx`](../FE-Audiomind/src/components/features/FeatureUpload.tsx) | Upload UI | Subject picker | Upload flow | Progress | upload tests |
| [`components/features/FeatureAnalysis.tsx`](../FE-Audiomind/src/components/features/FeatureAnalysis.tsx) | Analysis+transcript tabs | Education panel + evidence handler | UX | Tab state | component tests |
| [`components/analysis/AnalysisPanel.tsx`](../FE-Audiomind/src/components/analysis/AnalysisPanel.tsx) | Legacy analysis blocks | Conditional education vs legacy dedupe | UX | Duplicate keywords | tests |
| [`components/transcript/TranscriptDisplay.tsx`](../FE-Audiomind/src/components/transcript/TranscriptDisplay.tsx) | Grouped transcript rows | Optional `data-transcript-segment-id` fallback | Evidence | Grouping | transcript tests |
| [`utils/transcriptJump.ts`](../FE-Audiomind/src/utils/transcriptJump.ts) | Time-range scroll | Reuse; add id→time helper if needed | Evidence primary path | — | unit tests |
| `contexts/StudyWorkspaceProvider.tsx` **NEW** | — | Tree + picker catalog + invalidation revisions | Shared state | Over-fetch | hook tests |
| `hooks/useStudyWorkspace.ts` **NEW** | — | Context accessor | — | — | — |
| `hooks/useSubjectsList.ts` **NEW** | — | Page-local paginated subjects | Filters | Stale data | hook tests |
| `hooks/useSubjectDetail.ts` **NEW** | — | Parallel `getSubject` + `getSubjectMeetings` | Detail page | — | hook tests |
| `hooks/useUnclassifiedMeetings.ts` **NEW** | — | Page-local unclassified list | Filters | — | hook tests |
| `hooks/useTranscriptEvidenceNavigation.ts` **NEW** | — | id→segment→highlight→scroll | Evidence | Missing id | unit tests |
| `components/subjects/*` **NEW** | — | Sidebar, dialogs, picker, pages | Feature UI | — | component tests |
| `components/education/*` **NEW** | — | Education panel sections | Feature UI | Malformed payload | component tests |
| [`MeetingController.java`](../demoRecordAUDIOMID/meeting-service/src/main/java/com/example/meetingservice/controller/MeetingController.java) | Meetings API | **No change expected** unless integration gap found | Stable BE | — | existing tests |
| [`ProcessingController.java`](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java) | Saved analysis endpoint | **Verify only** passthrough of `educationStudy` | Data path | Field loss | processing tests |

**Matrix file count**: 31 rows (21 existing verified paths + 10 NEW groups/files).

## 7. Backend changes

- **Default**: giữ meeting-service hiện có; không mở rộng `SubjectMeetingResponse` trong Phase 1.
- **Review khi implement**:
  - `CreateRealtimeMeetingRequest`: `title`, `language`, `subjectId` only (no `domainMode`).
  - Upload duplicate: không mutate subject meeting cũ khi duplicate reuse.
  - Unclassified: document OpenAPI as page shape equivalent; implementation remains `Map` wrapper.

## 8. OpenAPI/generated client changes

**Contract update sequence:**

```bash
npm run validate:contracts
npm run generate:client
npm run typecheck:client
npm run check:openapi
```

**Drift check (cuối pipeline, sau khi generated output đã được stage/commit hoặc baseline diff được kiểm soát):**

```bash
npm run generate:client
git diff --exit-code -- packages/api-clients
```

- Không sửa tay `packages/api-clients/*.ts`.
- Không dùng drift check giữa chừng khi generated files chưa commit rồi kết luận sai là failure.

**Meeting-api scope Phase 1:**

- Chỉ bổ sung `subjectId` vào realtime create + multipart upload contract.
- **Không** thêm `domainMode` vào `meeting-api.yaml` (backend meeting-service không nhận/persist field này).

## 9. Frontend architecture

- Custom routing + App-level scenes (no new router/state lib).
- Layers: types/normalizer → services → `StudyWorkspaceProvider` → feature pages → subject/education components.

## 10. Routing design

- Extend `DashboardScene`: `subjects`, `subjectDetail`, `unclassified`.
- Paths: `/studio/subjects`, `/studio/subjects/:subjectId`, `/studio/unclassified`.
- `parseStudioRouteFromLocation`: dynamic `subjectId`, validate `> 0`, back/forward/reload.

## 11. Study state/cache design

`StudyWorkspaceProvider` **không** lưu toàn bộ paginated results phụ thuộc filter.

**Provider owns:**

- `folderTree`
- active subject catalog for pickers (non-archived)
- mutation helpers
- `treeRevision` / `catalogRevision` (or targeted refresh fns)
- shared loading/error for tree/catalog only

**Page hooks own paginated state:**

- `useSubjectsList(filters)`
- `useSubjectDetail(subjectId, filters)` — `Promise.all([getSubject, getSubjectMeetings])`
- `useUnclassifiedMeetings(filters)`

**Invalidation matrix:**

| Mutation | Provider refresh | Page hooks reload |
|---|---|---|
| Create/update/delete folder | `refreshFolderTree()` + bump revision | `useSubjectsList` if folder filter affected |
| Create/update/archive subject | tree + catalog refresh | subjects list + subject detail if open |
| Assign / change / remove meeting subject | catalog counts via tree revision | subject meetings (old+new), unclassified, meeting detail |

## 12. Folder/subject UI

- Production sidebar: [`DashboardLayout.tsx`](../FE-Audiomind/src/components/dashboard/DashboardLayout.tsx) + `SubjectSidebarSection`.
- Dialogs/pages: subjects list, subject detail, unclassified, folder/subject CRUD dialogs, `SubjectPicker`.

### Phương án B — **đã chốt** (không cần user xác nhận khi implement)

Phase 1 **không** mở rộng `SubjectMeetingResponse` trừ khi phát hiện blocker thực sự khi implement.

Subject detail meeting row **chỉ hiển thị**:

- title
- createdAt
- language
- status
- open
- change subject
- remove subject

`duration`, `sourceType`, `transcriptStatus`, `analysisStatus` → **Deferred** (§26); không tự dựng dữ liệu.

## 13. Record/upload integration

```typescript
type CreateRealtimeMeetingInput = {
  title: string
  language?: string
  subjectId?: number | null
  domainMode?: string // optional: preserve caller/processing flow only; NOT sent to meeting-service
}

type UploadMeetingInput = {
  title: string
  file: File
  language?: string
  subjectId?: number | null
  domainMode?: string // optional: processing start only; NOT meeting-api multipart field
}
```

- `subjectId`: append to meeting-service request only when `!= null`; never `"null"` / `"undefined"`.
- `domainMode`: tiếp tục đi theo processing/AI flow hiện tại (`startProcessingByPath`, realtime metadata); **không** mở rộng meeting-service contract.

## 14. Meeting subject reassignment

- `SubjectPicker` on meeting detail: assign / remove → `assignMeetingSubject` → provider invalidation.
- Không re-fetch analysis/transcript unnecessarily.

## 15. Education normalizer

- Extend `AiAnalysis` + `normalizeEducationStudyAnalysis`.
- Soft-fail malformed nested items; legacy analyses unchanged when field absent.
- **TypeScript quality**: no new `any`; no blind `as any` on education payload.

## 16. Education UI

- Render when `analysis.educationStudy != null` (not `domainMode` alone).
- Components under `components/education/*`; integrate via `AnalysisPanel` / `FeatureAnalysis`.
- `EducationAnalysisPanelProps`: `{ analysis; onEvidenceClick?: (segmentId: string) => void }`.

## 17. Evidence navigation design

**Primary path (not DOM-lookup-first):**

1. `educationStudy.sourceSegmentIds`
2. normalize/canonicalize if needed
3. map to **raw transcript segments before grouping** (`TranscriptSegment.id`, not assumed `segmentId` field name in FE model)
4. read `start` / `end` time
5. scene-specific: saved → `setActiveTab('content')` if tabs exist; realtime may skip tab switch
6. `setHighlightRange(highlightRangeFromTime(...))`
7. `scrollTranscriptToHighlight(...)`

`data-transcript-segment-id`: fallback/test hook only.

## 18. Processing-service/AI data flow

```text
Saved:
  FE → GET /processing/{id}/analysis/saved → stored JSON (verify educationStudy present)

Batch origin:
  processing job → ai-service analysis → persist payload

Realtime:
  FE ← WS job result
  processing-service → POST /api/internal/realtime-analysis (internal)
```

- Chỉ thêm Java DTO nếu trace proves strict boundary strips unknown fields.

## 19. Error handling

- Map 404/409/validation cho folder/subject/archived/unauthorized.
- FE: toast pattern; evidence miss → soft warning, no crash.

## 20. Test matrix

| Layer | Focus | Status |
|---|---|---|
| OpenAPI/contracts | folder/subject/pagination/subjectId/educationStudy | TODO |
| FE unit | normalizer, services, routing, id→time evidence, multipart rules | TODO |
| FE component | sidebar, picker, unclassified, education panel, evidence callback | TODO |
| Java | gap-only additions after source review | PARTIAL |
| AI | 3 education suites + full `pytest tests` | PARTIAL |

### TypeScript quality gate (acceptance)

- Không thêm TypeScript `any` mới trong diff Phase 1.
- Không dùng blind assertion (`as any`, `<any>`) cho education payload.
- Production build phải qua `tsc` (`npm --prefix FE-Audiomind run build`).

**Verification:**

```bash
npm run lint
npm --prefix FE-Audiomind run build
git diff --check
```

Review diff TS: reject new `: any`, `as any`, `<any>` (trừ file cũ ngoài scope Phase 1).

## 21. Exact build/test commands

- Root: `validate:contracts` → `generate:client` → `typecheck:client` → `check:openapi`
- FE: `npm --prefix FE-Audiomind run test`, `npm --prefix FE-Audiomind run build`, `npm run lint` (root)
- Java (cwd `demoRecordAUDIOMID`): `.\mvnw.cmd -pl meeting-service test --no-transfer-progress`, `.\mvnw.cmd -pl processing-service test --no-transfer-progress`
- AI (cwd `demoRecordAUDIOMID/ai-service`):

```bash
python -m pytest tests/test_education_analysis.py tests/test_education_schema.py tests/test_education_realtime_fragments.py
python -m pytest tests
```

## 22. Manual smoke scenarios

1. Folder + subject create; reload persists.
2. Realtime with `subjectId` → meeting in subject detail.
3. Upload with `subjectId`; duplicate semantics unchanged.
4. Unclassified assign → list/count update.
5. Education structured sections visible.
6. Evidence click → transcript highlight (saved scene tab switch).

## 23. Commit strategy

1. contracts + generated clients  
2. FE types + services  
3. routing + StudyWorkspaceProvider  
4. subject/folder/unclassified UI  
5. record/upload/reassign  
6. education UI + evidence  
7. tests  
8. docs  

Each: `git diff --check` + scoped test/build.

## 24. Acceptance criteria mapping (AC-01 … AC-55)

| ID | Criterion | Status | Evidence | Planned task | Verification | Blocking |
|---|---|---|---|---|---|---|
| AC-01 | Branch `feature/phase1-subject-education` | DONE | `git branch` | maintain | git | No |
| AC-02 | Không code trên `main` | DONE | process | maintain | git | No |
| AC-03 | Working tree sạch cuối Phase 1 | TODO | — | commit/review | git status | Yes |
| AC-04 | Branch cleanup report đúng thực tế | PARTIAL | audit-only report | update after Stage B decision | docs | No |
| AC-05 | Migration `study_folder` | DONE | V16 + tests | none | migration test | No |
| AC-06 | Migration `subject` | DONE | V16 | none | migration test | No |
| AC-07 | `meeting.subject_id` nullable | DONE | entity/migration | none | schema test | No |
| AC-08 | CRUD folder | PARTIAL | BE DONE; OpenAPI TODO; FE TODO | contracts + FE | Java+FE tests | Yes |
| AC-09 | CRUD subject | PARTIAL | BE DONE; OpenAPI TODO; FE TODO | contracts + FE | Java+FE tests | Yes |
| AC-10 | Folder cycle blocked | DONE | service tests | none | Java tests | No |
| AC-11 | Owner authorization | DONE | service/controller tests | none | Java tests | No |
| AC-12 | Gán meeting vào subject | PARTIAL | BE DONE; FE TODO | assign API + UI | Java+FE+smoke | Yes |
| AC-13 | Chuyển subject | PARTIAL | BE DONE; FE TODO | meeting detail picker | smoke | Yes |
| AC-14 | Bỏ subject | PARTIAL | BE DONE; FE TODO | assign null | smoke | Yes |
| AC-15 | Unclassified meetings | PARTIAL | BE DONE; FE TODO | unclassified page | Java+FE | Yes |
| AC-16 | Realtime create `subjectId` | PARTIAL | BE DONE; FE TODO | `createRealtimeMeeting` input | FE test+smoke | Yes |
| AC-17 | Upload `subjectId` | PARTIAL | BE DONE; FE TODO | multipart append | FE test+smoke | Yes |
| AC-18 | Archived subject không gán mới | DONE | service validation | none | Java tests | No |
| AC-19 | Meeting cũ không mất dữ liệu | DONE | migration nullable FK | none | regression | No |
| AC-20 | Không sidebar hard-code | TODO | no study API in nav | `SubjectSidebarSection` | component test | Yes |
| AC-21 | Folder tree từ API | TODO | — | tree client + sidebar | component test | Yes |
| AC-22 | Trang danh sách subject | TODO | — | subjects scene | FE test | Yes |
| AC-23 | Trang chi tiết subject | TODO | — | subjectDetail scene | FE test | Yes |
| AC-24 | Trang chưa phân loại | TODO | — | unclassified scene | FE test | Yes |
| AC-25 | Dialog tạo/sửa folder | TODO | — | folder dialogs | component test | Yes |
| AC-26 | Dialog tạo/sửa subject | TODO | — | subject dialogs | component test | Yes |
| AC-27 | Record subject selector | TODO | — | realtime form | FE test+smoke | Yes |
| AC-28 | Upload subject selector | TODO | — | upload form | FE test+smoke | Yes |
| AC-29 | Meeting detail đổi subject | TODO | — | picker on detail | smoke | Yes |
| AC-30 | Mutation cập nhật list/count | TODO | — | StudyWorkspace revisions | integration test | Yes |
| AC-31 | TS có `educationStudy` | TODO | type missing | extend types | unit test | Yes |
| AC-32 | Normalizer giữ `educationStudy` | TODO | normalizer gap | `normalizeEducationStudyAnalysis` | unit test | Yes |
| AC-33 | Batch analysis hiển thị education | PARTIAL | AI DONE; FE TODO | saved analysis UI | smoke | Yes |
| AC-34 | Realtime/saved hiển thị education | PARTIAL | AI DONE; FE TODO | realtime+saved paths | smoke | Yes |
| AC-35 | Overview | TODO | — | EducationOverview | component test | Yes |
| AC-36 | Learning objectives | TODO | — | panel section | component test | Yes |
| AC-37 | Sections | TODO | — | EducationSectionList | component test | Yes |
| AC-38 | Key points | TODO | — | EducationKeyPoints | component test | Yes |
| AC-39 | Keywords (education) | TODO | — | deduped display | component test | Yes |
| AC-40 | Glossary | TODO | — | EducationGlossary | component test | Yes |
| AC-41 | Must remember | TODO | — | EducationMustRemember | component test | Yes |
| AC-42 | Unclear points | TODO | — | EducationUnclearPoints | component test | Yes |
| AC-43 | Evidence jump transcript | TODO | id→time util partial | evidence navigation hook | unit+smoke | Yes |
| AC-44 | Invalid evidence không crash | TODO | — | soft-fail paths | unit test | Yes |
| AC-45 | Legacy analysis hoạt động | PARTIAL | existing normalizer | additive changes only | regression tests | Yes |
| AC-46 | Frontend lint | TODO | — | run lint | `npm run lint` | Yes |
| AC-47 | Frontend tests | TODO | — | vitest suite | `npm --prefix FE-Audiomind run test` | Yes |
| AC-48 | Frontend production build | TODO | — | tsc+vite | `npm --prefix FE-Audiomind run build` | Yes |
| AC-49 | Meeting-service tests | DONE | 130 passed (Step 6 report) | re-run after changes | mvnw meeting-service | No* |
| AC-50 | Processing-service tests | TODO | not verified this phase | run full module | mvnw processing-service | Yes |
| AC-51 | AI-service tests | PARTIAL | targeted partial | full pytest | `python -m pytest tests` | Yes |
| AC-52 | Không TS error mới | TODO | — | build gate | build+lint | Yes |
| AC-53 | Không migration conflict | DONE | V16 applied | none | migration test | No |
| AC-54 | Không phá realtime/STT/upload | TODO | — | regression smoke | manual+tests | Yes |
| AC-55 | Không secret trong commit | TODO | process | review commits | git diff | Yes |

\*AC-49 blocking only if backend regressions introduced during Phase 1 implementation.

**Status legend**: DONE | PARTIAL | TODO | BLOCKED (none currently).

**Dimension tags** (apply per row): Backend implementation | OpenAPI contract | Generated client | Frontend integration | Test verification.

## 25. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Transcript grouping mất segment DOM identity | id→raw segment→time; DOM attr fallback only |
| Custom routing dynamic path | tests for parse/back/forward/reload |
| Provider over-scope | page hooks own pagination; provider only tree/catalog |
| Stale sidebar counts | revision bumps on mutation matrix |
| Generated client drift | generate + controlled drift check |
| Pagination mismatch | lock `PageResponse` fields; 1-based page per service tests |
| Duplicate upload semantics | no backend change; FE subjectId only on new create path |
| Archived subject race | handle 4xx; refresh picker catalog |
| Legacy analysis break | additive normalizer only |
| Strict DTO strips `educationStudy` | trace processing saved endpoint before DTO work |
| Missing duration/status fields | **Phương án B locked** — no fabricated UI data |

## 26. Deferred items

- `duration`, `sourceType`, `transcriptStatus`, `analysisStatus` on subject meeting rows (no reliable DTO source).
- Bulk assign meetings (unless existing selection UX).
- Dead `Sidebar.tsx` cleanup — separate commit after feature stable.
- Git Stage B branch/tag cleanup — awaiting explicit user approval.
- `domainMode` on meeting-service OpenAPI — out of scope; processing/AI only.
