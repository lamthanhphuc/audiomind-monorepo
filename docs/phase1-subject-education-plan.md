# Phase 1 — Quản lý môn học và phân tích từng buổi

**Status:** In progress — Steps 0–4 implemented on `feature/phase1-subject-education`  
**Branch target:** `feature/phase1-subject-education` (tạo trong Git Stage A)  
**Base:** `main` — khi triển khai phải `git fetch origin` và xác minh `origin/main` mới nhất; ghi **commit SHA thực tế** vào `docs/branch-cleanup-report.md` và implementation report (không khóa cứng một SHA cố định).

Tài liệu này là source of truth cho triển khai Phase 1. Mọi quyết định quan trọng ghi **Verified against** với file/module đã kiểm tra.

---

## 0. Source facts đã xác minh

### 0.1 Ownership & persistence

| Fact | Location |
|------|----------|
| `Meeting` owned by meeting-service | `demoRecordAUDIOMID/meeting-service/.../entity/Meeting.java` |
| Flyway history V1–V15 | `.../resources/db/migration/`, `application.yml` |
| Soft delete via `deleted_at` | `V5__add_duplicate_guard_and_soft_delete_columns.sql` |
| Owner from JWT → `UserPrincipal.userId()` | `JwtAuthenticationFilter.java` |
| Live API `/meetings` (v1 deprecated 404) | `MeetingController`, `MeetingV1Controller` |
| Pagination `page`, `pageSize` | `MeetingController.getMeetings` |
| Upload duplicate: hash → early reuse | `MeetingController.upload` |
| Error 409 convention | `ErrorCode.CONFLICT` + `GlobalExceptionHandler` maps `HttpStatus.CONFLICT` |
| No subject/folder backend | repo-wide absence |

**Verified against:** meeting-service controllers/entities/migrations; FE `api.ts`.

### 0.2 Analysis & cache

| Fact | Location |
|------|----------|
| `PROMPT_VERSION = gemini-business-v2` | `ai_analyzer.py` |
| `domainMode` ∈ `{general,it,business,education}` | `STRUCTURED_DOMAIN_MODES`; FE `domainMode.ts` |
| `AnalysisCacheIdentity` + idempotency hash **omit domain** today | `analysis_runs.py` |
| Batch: cache lookup **before** analyze; save **after** | `pipeline.py` |
| `build_analysis_run_idempotency_key` parts | `analysis_runs.py` L194–211 |
| `idempotency_key` column unique+indexed; used by `begin_analysis_run` / `persist_completed_analysis_run` | `models.py`, `analysis_runs.py` |
| `find_completed_analysis_run_for_identity` uses `_identity_filters` + post-filter `analysis_feature_set` — **not** `idempotency_key` | `analysis_runs.py` L301–322, L325–359 |
| No `domain_mode` DB column on `meeting_analysis_runs` | `models.py`, alembic migrations |

**Verified against:** `pipeline.py`, `analysis_runs.py`, `ai_analyzer.py`, `main.py`, `models.py`.

### 0.3 Segment identity today

| Path | Before Gemini? | Notes |
|------|----------------|-------|
| **Batch** | **No** | `{speaker,start,end,text}` only; `event_id` often null on save |
| **Realtime (Deepgram)** | Yes | `stt_adapter._resolve_segment_id` → `transcript_fragments.event_id` |
| **Transcript GET** | Read-time | `main.py` `_build_segment_id` synthesizes if missing — **must delegate to shared helper** |
| **Gemini input** | — | `[MM:SS] speaker: text` — no `SEGMENT_ID` marker |
| **FE jump** | — | timestamp via `transcriptJump.ts`; `canonicalizeSegmentId` today **reformats** legacy IDs |
| **grpc_stt_service** | — | uses `uuid4()` for `segment_id`/`event_id` when emitting directly (`grpc_stt_service.py` L119–156) |
| **gRPC server** | Production path when `_get_stt_adapter()` OK | `main.py` L237–242; default `stt_provider=deepgram` (`config.py`) |

**Verified against:** `pipeline.py`, `stt_adapter.py`, `main.py`, `grpc_stt_service.py`, `TranscriptDisplay.tsx`, `transcript.ts`.

### 0.4 Frontend routing

| Fact | Location |
|------|----------|
| No React Router | History API + `DashboardScene` |
| `ParsedStudioRoute = { scene, meetingId, resultScope? }` | `studioRouting.ts` — **no path params yet** |
| Large files | `App.tsx` ~2472, `api.ts` ~1230, `types/index.ts` ~849 |

**Verified against:** `studioRouting.ts`, `App.tsx`, `DashboardLayout.tsx`.

### 0.5 OpenAPI / CI

| Fact | Location |
|------|----------|
| Contracts | `packages/contracts/{meeting,processing,ai,user}-api.yaml` |
| Scripts | root `package.json`: `generate:client`, `validate:contracts`, `check:openapi`, `typecheck:client` |
| CI `build-test` | `.github/workflows/ci.yml` |
| CI Java tests | `./mvnw test` (Surefire phase only — **no** Failsafe plugin in `demoRecordAUDIOMID/pom.xml`) |
| CI Python lint | `ruff check demoRecordAUDIOMID/ai-service`; `black --check demoRecordAUDIOMID/ai-service` |
| meeting-service: no Postgres IT today | unit/Mockito only |
| No `pyproject.toml` | `requirements-dev.txt` has `pytest>=8` |

**Verified against:** `ci.yml`, root `package.json`, `demoRecordAUDIOMID/pom.xml`, `meeting-service/pom.xml`.

---

## 1. Goals / non-goals

### Goals

```text
Tạo folder → tạo môn → chọn môn khi ghi/upload
→ xem buổi theo môn → chuyển môn / chưa phân loại
→ education analysis có cấu trúc → bấm evidence → đúng segment transcript
```

### Non-goals (Phase 2+)

- Multi-meeting subject aggregation
- AI auto-classify subject
- Per-sharee taxonomy (`user_meeting_subject`)
- Modernize toàn bộ `/api/v1` legacy contract trong Phase 1
- Remote/local branch deletion without Stage B approval

### Hard constraints

- Flyway V16+ only; `subject_id` nullable; no data loss
- Không phá realtime/upload/STT/analysis/export
- Không commit secrets; không code trên `main`

---

## 2. Kept decisions (confirmed)

- `meeting-service` owns `study_folder`, `subject`, `meeting.subject_id`
- Folder soft delete; subject soft archive (`archived_at`)
- Archive unassigns meetings → unclassified
- `educationStudy` optional; backward compatible
- `domainMode=education` reused; subject picker **suggests** only
- JWT principal only; IDOR tests required
- Pagination `page` / `pageSize`

---

## 3. Git safety (two-phase)

### Stage A — Audit-only (tuyệt đối)

**Được phép:**

- `git status`, `git fetch --all --prune`, `git remote -v`, `git branch -a`
- Phân loại branch: merged / unmerged / divergence / open PR (`gh pr list --head <branch>`)
- Tạo draft `docs/branch-cleanup-report.md`
- `git checkout main` + `git pull --ff-only origin main` (nếu fail → dừng, báo divergence, không force)
- Ghi **SHA `origin/main` thực tế** vào report
- `git checkout -b feature/phase1-subject-education`
- Bắt đầu triển khai Phase 1 trên feature branch **ngay cả khi Stage B chưa duyệt**

**Cấm tuyệt đối trong Stage A:**

- Xóa local branch
- Xóa remote branch
- Tạo archive tag
- Push tag
- `git reset --hard`, `git clean -fd`
- `git push --delete`

**Working tree dirty:**

```bash
git stash push -u -m "backup-before-phase1-subject-education"
# ... checkout main, pull, create feature branch ...
git stash apply
# Xác minh đầy đủ thay đổi đã phục hồi (git status, git diff)
git stash drop   # chỉ sau khi xác minh OK — KHÔNG dùng git stash pop ngay
```

**Báo cáo Stage A** (`docs/branch-cleanup-report.md`) phải có các cột:

| Cột | Mô tả |
|-----|--------|
| Kept | Branch giữ lại |
| Proposed delete (local) | Đề xuất xóa local — **chờ Stage B** |
| Proposed delete (remote) | Đề xuất xóa remote — **chờ Stage B** |
| Unmerged | Commit chưa có trong `main` |
| Open PR | PR đang mở |
| Protected / permission | Không thể xóa |
| Archive tag (planned) | Chỉ lập kế hoạch — **chưa tạo trong Stage A** |
| Awaiting user approval | Mọi đề xuất xóa |

### Stage B — Deletion (chỉ sau phê duyệt người dùng)

Mọi xóa **local hoặc remote** chỉ thực hiện sau khi người dùng duyệt danh sách trong report.

Với branch **chưa merge** được duyệt xóa:

1. Tạo archive tag `archive/<sanitized>-YYYYMMDD` (kiểm tra không trùng)
2. `git push origin <tag>` — chỉ coi là backup thành công sau push OK
3. Xóa local/remote theo danh sách đã duyệt
4. Cập nhật report: tag pushed / delete success / failures

**Tách biệt:** tạo `feature/phase1-subject-education` **không** phụ thuộc hoàn thành Stage B.

---

## 4. Architecture map

```mermaid
flowchart TB
  subgraph fe [FE-Audiomind]
    SubjectsUI[subjects features]
    EduUI[education features]
    Routing[studioRouting path params]
    Jump[transcriptJump by segmentId]
  end
  subgraph ms [meeting-service]
    FolderAPI[/study-folders]
    SubjectAPI[/subjects]
    MeetingAPI[/meetings subject assign]
    FlywayV16[Flyway V16]
  end
  subgraph ai [ai-service]
    SegId[segment_identity.py]
    CacheRes[resolve_analysis_versions]
    EduNorm[education_analysis normalize]
    Gemini[Gemini educationStudy]
  end
  SubjectsUI --> FolderAPI
  SubjectsUI --> SubjectAPI
  SubjectsUI --> MeetingAPI
  EduUI --> Jump
  SegId --> Gemini
  CacheRes --> Gemini
  Gemini --> EduNorm
```

---

## 5. Segment Identity Contract

### 5.1 Backend source of truth (locked)

**`demoRecordAUDIOMID/ai-service/app/services/segment_identity.py`** là implementation source of truth **duy nhất** phía backend.

Tất cả đường dẫn sau **phải gọi helper này** — không duy trì công thức độc lập trong:

```text
stt_adapter.py
main.py
pipeline.py
grpc_stt_service.py
canonical_persist_service.py (uuid4 path — thay bằng shared helper)
```

**Hàm dự kiến:**

```python
build_stable_segment_id(meeting_id, segment, *, zero_based_index, collision_index=1) -> str
assign_stable_segment_ids(meeting_id, segments) -> list[dict]  # sets segment_id + event_id
format_segment_marker(segment_id: str) -> str  # "[SEGMENT_ID=...]"
collect_allowed_segment_ids(segments) -> set[str]
```

### 5.2 ID algorithm (deterministic, no UUID)

**Primary key components:**

```text
meeting-{meetingId}-start-{start:.3f}-{speakerNormalized}
```

**Fallback rules (locked):**

| Condition | Rule |
|-----------|------|
| Speaker missing/blank | `speaker_unknown` |
| Start valid (finite number) | `start-{start:.3f}` in ID |
| Start missing/invalid | `index-{zeroBasedIndex}` instead of start component |
| Collision same meeting + same resolved key | append `-seq-{oneBasedCollisionIndex}` |

**Must NOT use:** `uuid4()`, DB auto-increment, random per-request synthesis.

### 5.3 Shared test vectors (Python + FE contract tests)

Cùng bộ vector cho `segment_identity.py` tests và FE contract test (expected strings from backend):

| Case | Input sketch | Expected behavior |
|------|--------------|-------------------|
| Normal | meeting 12, start 10.0, `SPEAKER_1` | `meeting-12-start-10.000-speaker_1` |
| Many decimals | start `10.1234567` | rounds/format to 3 decimals: `10.123` |
| Speaker casing | `Speaker_1` / `SPEAKER_1` | normalize to lowercase speaker token |
| Collision | two segments same start+speaker | second gets `-seq-2` |
| Missing start | no start, index 0 | uses `index-0` component |
| Missing speaker | start 5.0, no speaker | `speaker_unknown` |

### 5.4 Batch pipeline

In `pipeline.py`, **before** `format_transcript_for_analysis` and **before** cache lookup / Gemini:

1. `assign_stable_segment_ids(meeting_id, aligned_segments)`
2. Format Gemini transcript:

```text
[SEGMENT_ID=meeting-12-start-10.000-speaker_1]
[00:10] SPEAKER_1: Nội dung
```

3. `allowedSegmentIds = collect_allowed_segment_ids(...)`
4. Pass into analyze metadata
5. `_save_results` persists same id to `transcript_fragments.event_id`

### 5.5 Realtime path

- Read/consume IDs from storage via `segment_identity` when assembling fragments
- `stt_adapter` delegates ID resolution to `segment_identity` (remove duplicate formula)
- `main.py` `_build_segment_id` → thin wrapper: return stored id OR `build_stable_segment_id(...)` — **same helper**

### 5.6 grpc_stt_service (Step 0 gate — see §15)

**Step 0 implementation task:** xác định path có được runtime production dùng.

**Verified today:** gRPC server starts when `_get_stt_adapter()` succeeds (`main.py`); default `stt_provider=deepgram`. `grpc_stt_service.py` still assigns `uuid4()` segment ids when emitting events directly.

**If path is reachable in production:**

- Canonicalize via `segment_identity.py` **before** persist/analysis in `grpc_stt_service.py`

**If confirmed deprecated/unreachable:**

- Ghi rõ trong implementation report: evidence guarantee không áp dụng
- Không refactor lớn path không hoạt động

### 5.7 educationStudy validation

- Filter `sourceSegmentIds` ⊆ `allowedSegmentIds`
- Dedupe; drop cross-meeting IDs
- Item with no valid IDs: **keep item**, `sourceSegmentIds=[]`
- Normalize failure: omit `educationStudy`, keep business fields

### 5.8 Frontend (locked)

- **Không** tái tạo segment ID từ timestamp/speaker
- Dùng nguyên `segmentId` / `segment_id` backend trả về
- `canonicalizeSegmentId` (`transcript.ts`) **chỉ được:**
  - Chấp nhận alias field (`segmentId` / `segment_id` / `id`)
  - Trim chuỗi
  - **Không** thay đổi một canonical ID hợp lệ (loại bỏ legacy reformat logic)
- `TranscriptDisplay.tsx`: `data-segment-id={segmentId}`
- `transcriptJump.ts`: `scrollTranscriptToSegmentId(id)`; giữ timestamp fallback cho analysis cũ

---

## 6. AI cache identity contract (locked)

### 6.1 Problem (verified against `analysis_runs.py`)

| Component | Behavior today |
|-----------|----------------|
| `build_analysis_run_idempotency_key` | SHA-256 over identity parts — **no** `domainMode` |
| `MeetingAnalysisRun.idempotency_key` | DB column `String(256)`, **unique**, indexed (`models.py`) |
| `begin_analysis_run` / `persist_completed_analysis_run` | Lookup/create by **`idempotency_key`** |
| `find_completed_analysis_run_for_identity` | SQL via `_identity_filters` on columns (`meeting_id`, hash, provider, model, `prompt_version`, `schema_version`, …) then **Python post-filter** `_run_analysis_feature_set(run) == identity.analysis_feature_set` — **does not query `idempotency_key`** |
| Shared versions for `general`/`it`/`business` | Same prompt/schema/feature → completed lookup **can hit across domains** |

**Conclusion:** Chỉ thêm domain vào hash **không đủ** nếu completed lookup vẫn dựa `_identity_filters` + shared `analysisFeatureSet`. Phải đổi completed lookup và/hoặc tách `analysisFeatureSet` theo domain.

### 6.2 Design (locked)

| Rule | Detail |
|------|--------|
| **No new DB column** | Không thêm `domain_mode` / `normalized_domain_mode` column Phase 1; **không** migration mới cho domain |
| **No `_identity_filters` change** | Không thêm domain vào `_identity_filters` (không có DB column tương ứng) |
| **In-memory identity field** | Thêm `normalized_domain_mode: str` vào Python dataclass `AnalysisCacheIdentity` — **chỉ in-memory**, không map ORM |
| **Hash includes domain** | `build_analysis_run_idempotency_key_for_identity(identity)` đọc trực tiếp `identity.normalized_domain_mode` và đưa vào key parts |
| **Metadata** | `domainMode` / `domain_mode` trong analysis payload (persisted JSON) |
| **Resolve before lookup** | Normalize domain → resolve versions → build identity (có `normalized_domain_mode`) → build key |
| **Shared resolver** | Batch (`pipeline.py`) + realtime (`main.py`) cùng module; **cả hai phải truyền domain** khi tạo identity |
| **Single key helper** | Completed lookup, `begin_analysis_run`, `persist_completed_analysis_run` đều gọi `build_analysis_run_idempotency_key_for_identity(identity)` → **cùng kết quả** cho cùng identity |
| **Không chỉ dựa prompt/schema** | `general`/`it`/`business` vẫn chung `gemini-business-v2` — isolation qua domain trong key + domain-specific feature set |

### 6.3 Completed-run lookup (locked — exact query)

**Primary (required):** `find_completed_analysis_run_for_identity` phải dùng `idempotency_key` — field DB đã có và đã dùng ở `begin_analysis_run` / `persist_completed_analysis_run`:

```python
def find_completed_analysis_run_for_identity(
    db: Session, identity: AnalysisCacheIdentity
) -> MeetingAnalysisRun | None:
    idempotency_key = build_analysis_run_idempotency_key_for_identity(identity)
    return (
        db.query(MeetingAnalysisRun)
        .filter(
            MeetingAnalysisRun.status == ANALYSIS_STATUS_COMPLETED,
            MeetingAnalysisRun.idempotency_key == idempotency_key,
        )
        .order_by(MeetingAnalysisRun.completed_at.desc(), MeetingAnalysisRun.id.desc())
        .first()
    )
```

`begin_analysis_run` và `persist_completed_analysis_run` cũng phải dùng **cùng** `build_analysis_run_idempotency_key_for_identity(identity)` (đã gần đúng hôm nay; bắt buộc identity mang `normalized_domain_mode` trước khi gọi).

**Defense-in-depth:** `analysisFeatureSet` **domain-specific** cho mọi domain (kể cả khi prompt/schema giống nhau). Giá trị này vẫn vào identity + idempotency hash + payload (pattern `_run_analysis_feature_set` hiện tại). Không thêm SQL filter cho cột domain không tồn tại.

**Không** dựa completed cache vào `_identity_filters` alone với prompt/schema chung.

### 6.4 Version table (domain-isolated feature sets)

| `normalizedDomainMode` | promptVersion | schemaVersion | analysisFeatureSet |
|------------------------|---------------|---------------|--------------------|
| `education` | `education-analysis-v1` | `education-study-v1` | `education-study-v1` |
| `general` | `gemini-business-v2` | `gemini-business-v2` | `grouped-action-plan-v1-general` |
| `it` | `gemini-business-v2` | `gemini-business-v2` | `grouped-action-plan-v1-it` |
| `business` | `gemini-business-v2` | `gemini-business-v2` | `grouped-action-plan-v1-business` |

Lượt analysis cũ với `analysisFeatureSet=grouped-action-plan-v1` (không suffix) → **cache miss** có chủ đích sau Phase 1 (recompute theo domain hiện tại).

### 6.5 `AnalysisCacheIdentity` + functions (dự kiến)

```python
@dataclass(frozen=True)
class AnalysisCacheIdentity:
    # ... existing fields ...
    analysis_feature_set: str | None
    recording_session_id: int | None = None
    attempt_id: int | None = None
    normalized_domain_mode: str = "it"  # IN-MEMORY ONLY — never persisted as DB column

def normalize_domain_mode(value: Any, *, default: str = "it") -> str:
    """general | it | business | education; invalid → default (explicit, tested)"""

def resolve_analysis_versions(domain_mode: str) -> dict[str, str]:
    """promptVersion, schemaVersion, analysisFeatureSet — feature set domain-suffixed"""

def build_analysis_cache_identity(
    ...,
    normalized_domain_mode: str,  # REQUIRED — already normalized by caller
    analysis_payload: dict[str, Any] | None = None,
    ...
) -> AnalysisCacheIdentity:
    """Store normalized_domain_mode on identity; versions come from analysis_payload"""

def build_analysis_run_idempotency_key_for_identity(identity: AnalysisCacheIdentity) -> str:
    """MUST read identity.normalized_domain_mode into hash parts — do not re-normalize ad hoc"""

def find_completed_analysis_run_for_identity(db, identity) -> MeetingAnalysisRun | None:
    """PRIMARY: status=COMPLETED AND idempotency_key == build_..._key_for_identity(identity)"""
```

**End-to-end flow (batch + realtime identical):**

1. `normalized = normalize_domain_mode(...)` — invalid → default; **missing domain must not silently map to another caller's domain** (xem tests)
2. `versions = resolve_analysis_versions(normalized)`
3. Batch **và** realtime truyền `normalized_domain_mode=normalized` (+ versions/`domainMode` trong payload) vào `build_analysis_cache_identity`
4. `key = build_analysis_run_idempotency_key_for_identity(identity)` — đọc `identity.normalized_domain_mode`
5. Same `key` dùng cho: completed lookup → `begin_analysis_run` → `persist_completed_analysis_run`
6. If `mode != force`: `find_completed_analysis_run_for_identity` → filter by that `idempotency_key`
7. On miss: begin → analyze → persist (same helper)

**Force:** skip completed lookup; new key `"{base}:force:{uuid}"` (existing).

### 6.6 Cache test matrix (required)

Same transcript + same provider/model/scope:

| From → To | Expected |
|-----------|----------|
| IT → GENERAL | cache **miss** |
| GENERAL → BUSINESS | cache **miss** |
| BUSINESS → IT | cache **miss** |
| EDUCATION → IT | cache **miss** |
| IT → EDUCATION | cache **miss** |
| Same domain + same versions | cache **hit** |
| Same domain + changed prompt/schema/feature | cache **miss** |
| `mode=force` | **bypass** completed lookup |

**Identity/key consistency tests (required):**

| Case | Expected |
|------|----------|
| Same `AnalysisCacheIdentity` | Key tại completed lookup **==** key tại `begin_analysis_run` **==** key tại `persist_completed_analysis_run` |
| Missing / omitted domain on identity path | Không silently mặc định sang domain khác trong cùng request path mà không qua `normalize_domain_mode`; key phải phản ánh domain đã normalize theo contract (fail rõ hoặc default document + assert) |
| Invalid domain string (e.g. `"foo"`) | `normalize_domain_mode` chạy **trước** khi identity được tạo; identity store default hợp lệ; không ghi raw invalid vào `normalized_domain_mode` |

### 6.7 Module split

Prefer `analysis_versioning.py` (new) + thin changes in `analysis_runs.py` (`AnalysisCacheIdentity`, `find_completed_…`, key-for-identity), `pipeline.py`, `main.py`.

---

## 7. Duplicate upload + `subjectId` (locked)

**Order** (`MeetingController.upload`):

1. Validate file
2. Principal
3. Optional `subjectId` (multipart)
4. **Validate subject** (exists, owner, not archived) → invalid: **400/403**, stop
5. Hash + duplicate lookup
6. Duplicate → return existing meeting **with current `subjectId`**; **never mutate** subject
7. New → `saveMeeting(..., subjectId)`

FE: hiển thị duplicate + subject hiện tại; user có thể `PATCH /meetings/{id}/subject` sau.

**Realtime:** validate optional `subjectId` before `saveMeeting`; extend `CreateRealtimeMeetingRequest`.

---

## 8. Shared meeting authorization (locked)

| Operation | Who |
|-----------|-----|
| Assign/clear subject | Owner only |
| `GET /meetings/unclassified` | Owned only |
| `GET /subjects/{id}/meetings` | Owned only |
| Folder/subject CRUD | Owner only |
| Sharee | Read meeting; **cannot** change `subject_id` |
| Sharee taxonomy | Not in owner's folder tree / unclassified |

---

## 9. Database (Flyway V16)

**File:** `V16__study_folder_subject_and_meeting_subject.sql`

### 9.1 Tables & FK

- `study_folder`, `subject`, `meeting.subject_id BIGINT NULL`
- Foreign key on meeting (direction locked):

```sql
ALTER TABLE meeting
  ADD COLUMN subject_id BIGINT NULL;

ALTER TABLE meeting
  ADD CONSTRAINT fk_meeting_subject
  FOREIGN KEY (subject_id)
  REFERENCES subject(id)
  ON DELETE SET NULL;
```

- **Never** cascade delete meeting when a subject is removed
- Archive/delete subject still runs app transaction that nulls `meeting.subject_id` before/as `archived_at` is set (idempotent with `ON DELETE SET NULL` as safety net)
### 9.2 Partial unique indexes

```sql
CREATE UNIQUE INDEX uq_study_folder_owner_parent_name_active
ON study_folder (owner_user_id, COALESCE(parent_folder_id, -1), lower(btrim(name)))
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX uq_subject_owner_name_active
ON subject (owner_user_id, lower(btrim(name)))
WHERE archived_at IS NULL;
```

### 9.3 Transactions

| Action | Steps (single transaction) |
|--------|---------------------------|
| **DELETE /subjects/{id}** (archive) | `UPDATE meeting SET subject_id=NULL WHERE …` → `SET archived_at=now()` |
| **DELETE folder** | Block if non-deleted child folders (409); else `UPDATE subject SET folder_id=NULL` → `folder.deleted_at=now()` |

**Archive idempotency (locked):** `DELETE /subjects/{id}` trên subject **đã archived** → **200 OK** trả subject archived hiện tại (idempotent). Không hard-delete row.

**Duplicate name:** service validation + DB unique index → `ResponseStatusException(HttpStatus.CONFLICT)` → `ErrorCode.CONFLICT` (409) theo convention hiện tại (`ErrorCode.java`, `GlobalExceptionHandler`).

### 9.4 Indexes

`idx_study_folder_owner`, `idx_study_folder_parent`, `idx_subject_owner`, `idx_subject_folder`, `idx_meeting_subject`, optional `idx_meeting_owner_unclassified` partial.

---

## 10. Migration smoke test (PostgreSQL thật)

Unit/Mockito **không đủ**.

**Naming (locked):** `StudyFolderSubjectMigrationTest.java` — **không** dùng suffix `*IT` vì:

- CI chạy `./mvnw test` (Surefire), không chạy Failsafe/`verify` integration phase
- `demoRecordAUDIOMID/pom.xml` và `meeting-service/pom.xml` **không** cấu hình `maven-failsafe-plugin`
- Precedent: `ConfigControllerSecurityIntegrationTest` (Surefire) trong processing-service

**Tech:** Testcontainers PostgreSQL (precedent: `RealtimeEventSubscriberRedisIT` in processing-service — add `testcontainers` + `testcontainers-junit-jupiter` + `testcontainers-postgresql` test deps to meeting-service; Boot 4 BOM does **not** manage legacy `org.testcontainers:postgresql`).

**Scenarios:**

1. Empty DB → migrate V16
2. Migrate V15 → insert legacy meeting → V16 → `subject_id IS NULL`, row preserved
3. Create folder/subject; FK works
4. Partial unique index conflict → 409/exception
5. Archive subject unassigns meetings in transaction

---

## 11. Backend API contract

**Surface:** live controllers (`/meetings`, `/study-folders`, `/subjects`) — **not** deprecated `MeetingV1Controller`.

### 11.1 Endpoints

**Folder:** `POST/GET/PATCH/DELETE /study-folders`, `GET /study-folders/tree`

**Subject:** `POST/GET/PATCH/DELETE /subjects`, `GET /subjects/{id}/meetings`

**Meeting:** `PATCH /meetings/{id}/subject`, `GET /meetings/unclassified`, optional `subjectId` on upload/realtime

### 11.2 API behavior (locked)

| Rule | Detail |
|------|--------|
| **Archived subjects** | Không xuất hiện trong record/upload `SubjectPicker` |
| **Folder tree default** | Chỉ active subjects (`archived_at IS NULL`) |
| **List archived** | `GET /subjects?archived=true` (default `false`) |
| **Sort** | Whitelist map only — e.g. `name`, `updatedAt`, `createdAt`, `meetingCount`; **không** đưa client sort field trực tiếp vào SQL |
| **Duplicate name** | HTTP **409** `ErrorCode.CONFLICT` |
| **DELETE subject** | Soft archive (`archived_at`); idempotent nếu đã archived |
| **Pagination** | `page`, `pageSize`; response `{items,total,page,pageSize,totalPages}` |

### 11.3 Sort whitelist (example)

```java
// Allowed: name_asc, name_desc, updatedAt_desc, createdAt_desc, meetingCount_desc
// Unknown sort param → 400 VALIDATION_ERROR or default sort
```

---

## 12. OpenAPI scope (locked)

| Rule | Detail |
|------|--------|
| **Additive only** | Chỉ bổ sung/chỉnh live endpoints Phase 1 cần |
| **No v1 modernization** | Không hiện đại hóa toàn bộ `/api/v1` legacy trong Phase 1 |
| **No legacy removal** | Không xóa contract legacy CI/client đang tham chiếu |
| **Accuracy** | Paths mới phản ánh đúng `/meetings`, `/subjects`, `/study-folders` |
| **Generated clients** | Chỉ thay đổi qua `npm run generate:client` — không edit tay `packages/api-clients/*.ts` |

**Files:**

- `packages/contracts/meeting-api.yaml` — Phase 1 live paths + `Meeting.subjectId`
- `packages/contracts/ai-api.yaml` — optional `educationStudy`
- Regenerate `packages/api-clients/meeting.ts`, `ai.ts`

### 12.1 Generated-client verification (locked)

Ngay sau `npm run generate:client`, working tree **có thể** có intended diff — **không** coi đó là lỗi.

**Quy trình triển khai (developer):**

1. Sửa contract YAML Phase 1
2. `npm run generate:client`
3. `git diff -- packages/api-clients` — review
4. Xác nhận diff **chỉ** thuộc thay đổi contract Phase 1
5. Commit **cùng** contract YAML + generated output
6. Trên working tree **sạch** (sau commit), hoặc trong CI: chạy lại `npm run generate:client`
7. Chỉ khi đó mới assert:

```bash
git diff --exit-code -- packages/api-clients
```

**CI (`contract-check` job):** đã checkout commit có contract + client đã commit; bước generate lại + `git diff --exit-code` kiểm tra drift — đúng quy trình bước 6–7.

**Không** chạy `git diff --exit-code -- packages/api-clients` ngay sau generate lần đầu trên working tree bẩn/chưa commit và báo fail vì intended Phase 1 output.
---

## 13. Education analysis

### 13.1 Modules

- `education_analysis.py` — normalize/validate
- `schemas/education.py` or `schemas.py` section
- Thin hooks in `ai_analyzer.py`

### 13.2 Realtime education behavior (locked — not an open risk)

Khi `domainMode=education`:

1. Ưu tiên đọc structured transcript fragments từ storage
2. Nếu có fragments → dùng stored stable segment IDs qua `segment_identity`
3. Nếu **không** có fragments nhưng có plain transcript → vẫn tạo `educationStudy`; mọi `sourceSegmentIds=[]`
4. Ghi warning / `evidenceUnavailable: true` trong analysis metadata nếu schema cho phép (top-level metadata, không bắt buộc nested field mới)
5. **Không** tự tạo evidence IDs từ plain text

### 13.3 Normalize

Arrays → `[]`; trim; HIGH|MEDIUM|LOW; dedupe; invalid segment strip; malformed nested skip; Vietnamese Unicode; partial/empty OK; failure không xóa summary/action_items/keywords hiện có.

---

## 14. Frontend plan

### 14.1 Module layout

```text
types/subjects.ts, types/education.ts
services/studyFolders.ts, services/subjects.ts
components/subjects/, components/education/
hooks/useTranscriptEvidenceNavigation.ts
```

### 14.2 Routing

Extend `ParsedStudioRoute`:

```typescript
{ scene, meetingId, resultScope?, subjectId?: number | null }
```

Parser: `/studio/subjects`, `/studio/subjects/:id`, `/studio/meetings/unclassified` — **không** nhét vào `Record<DashboardScene,string>` static-only.

**Files:** `studioRouting.ts`, `studioRouting.test.ts`, `DashboardLayout.tsx`, `App.tsx`, `useStudioRouteSync.ts`, new scene components.

### 14.3 UI

- Sidebar **HỌC TẬP**; SubjectPicker active subjects only; suggest `domainMode=education`
- Education panel when `educationStudy` present
- Evidence jump §5.8

---

## 15. Implementation order

```text
Step 0  — Re-verify on branch tip + grpc_stt_service runtime reachability decision
Step 1  — Git Stage A (audit-only) + feature/phase1-subject-education + report draft
Step 2  — segment_identity.py + shared tests/vectors
Step 3  — analysis_versioning.py + cache hash domain part + batch/realtime wire-up
Step 4  — Flyway V16 + StudyFolderSubjectMigrationTest (Testcontainers)
Step 5  — Folder/subject domain + APIs + sort whitelist + 409 + archive idempotency
Step 6  — Meeting assignment + upload/realtime subjectId + duplicate tests
Step 7  — Education schema/prompt/normalize + segment markers + realtime edge behavior
Step 8  — OpenAPI additive contracts + generate:client
Step 9  — FE routing + subject/folder UI
Step 10 — Record/upload SubjectPicker (active only)
Step 11 — Education UI + evidence navigation (segmentId only)
Step 12 — Full verification (§17)
Step 13 — Conventional commits + implementation report (ghi origin/main SHA thực tế)
Step 14 — Git Stage B ONLY after user approves deletion list
```

---

## 16. Test plan (summary)

- Git Stage A/B checklist (manual)
- Migration Testcontainers (`StudyFolderSubjectMigrationTest`)
- IDOR + shared meeting
- Duplicate upload matrix
- AI cache matrix (§6.6): IT↔GENERAL↔BUSINESS miss; EDUCATION↔IT miss; same-domain hit; version change miss; force bypass; completed lookup by `idempotency_key`
- Segment vectors (§5.3); batch/realtime/grpc-if-applicable
- FE routing deep link; archived subject hidden from picker
- OpenAPI contract CI scripts

---

## 17. Verification commands (exact — from CI/config)

**Source:** `.github/workflows/ci.yml`, root `package.json`, `FE-Audiomind/package.json`, `demoRecordAUDIOMID/pom.xml`.

### Root (contracts — mirrors `contract-check` job)

```bash
npm ci
npm run validate:schema
npm run validate:contracts
npm run check:openapi
npm run generate:client
npm run typecheck:client
# ONLY after generated clients are committed / on a clean tree (see §12.1):
git diff --exit-code -- packages/api-clients
```

**Local Phase 1 first generate:** expect intended diff under `packages/api-clients` → review → commit with YAML → then re-run generate + exit-code check on clean tree.
### Monorepo policy + lint (mirrors `build-test` job)

```bash
npm run validate:policy
npm run lint
```

### Python ai-service (mirrors CI `Lint Python` + `Run tests`)

```bash
pip install -r demoRecordAUDIOMID/ai-service/requirements.txt \
  -r demoRecordAUDIOMID/ai-service/requirements-dev.txt
pip install ruff black
ruff check demoRecordAUDIOMID/ai-service
black --check demoRecordAUDIOMID/ai-service
python -m pytest demoRecordAUDIOMID/ai-service/tests --ignore=demoRecordAUDIOMID/ai-service/tests/stress
```

### Java (mirrors CI `Run tests` — Surefire via `test` goal)

```bash
cd demoRecordAUDIOMID
chmod +x ./mvnw    # Unix; Windows: .\mvnw.cmd
./mvnw test --no-transfer-progress
# Targeted meeting-service + migration test after added:
./mvnw -pl meeting-service test --no-transfer-progress
./mvnw -pl meeting-service -Dtest=StudyFolderSubjectMigrationTest test --no-transfer-progress
```

**Note:** CI `Build Java` runs `./mvnw -B verify -DskipTests` (compile only). Full module test gate is `./mvnw test`.

**Windows equivalent:**

```powershell
cd demoRecordAUDIOMID
.\mvnw.cmd test --no-transfer-progress
.\mvnw.cmd -pl meeting-service test --no-transfer-progress
.\mvnw.cmd -pl meeting-service "-Dtest=StudyFolderSubjectMigrationTest" test --no-transfer-progress
```

### Frontend (mirrors CI `Run tests`)

```bash
cd FE-Audiomind
npm test
npx tsc --noEmit
npm run build
```

### Optional local gates (not in main CI `build-test`, but in `security-recheck.yml` for PRs)

```bash
cd FE-Audiomind && npm run test:coverage
cd demoRecordAUDIOMID && ./mvnw -pl meeting-service test
python -m pytest demoRecordAUDIOMID/ai-service/test_api.py
```

**Acceptance:** above commands exit 0; migration Testcontainers green; client drift check only on clean tree after commit (§12.1) — không fail vì intended generate diff trước commit.

---

## 18. Commit strategy (when implementing)

```text
docs: add phase 1 subject education plan
chore(git): add branch cleanup audit report (stage A only)
feat(ai): add segment identity source of truth
feat(ai): domain-aware analysis cache identity
feat(subjects): add folder and subject persistence
feat(meetings): support subject assignment and upload subjectId
feat(ai): add education study structured analysis
chore(contracts): add phase 1 live OpenAPI paths
feat(frontend): add subject navigation and selectors
feat(frontend): render education analysis evidence
test(subjects): cover subject education workflows
docs: add phase 1 implementation report
```

---

## 19. Acceptance criteria

1. Stage A: **zero** branch/tag delete
2. Stage B: deletes only after user approval + archive tag push success (unmerged)
3. `origin/main` SHA recorded at implementation start
4. `segment_identity.py` sole backend ID source; FE uses backend `segmentId` as-is
5. Batch IDs before Gemini; markers == API == DOM
6. Completed cache lookup filters by **`idempotency_key`**; `AnalysisCacheIdentity.normalized_domain_mode` in-memory only (no DB column / no `_identity_filters`); key-for-identity shared across lookup/begin/persist; domain-specific `analysisFeatureSet`; batch+realtime pass domain
7. Cache matrix §6.6 green (all four domains isolated; force bypass)
8. Duplicate upload never mutates subject; validate before reuse
9. Shared user cannot assign subject; owned-only unclassified/subject lists
10. Archived subjects hidden from pickers; tree active-only; `archived` query param
11. Duplicate names → 409 CONFLICT; archive idempotent
12. OpenAPI additive scope; generated clients via generator; drift check only after commit/clean re-generate (§12.1)
13. `StudyFolderSubjectMigrationTest` on real Postgres
14. Dynamic subject routes + deep link
15. Realtime plain-transcript education: `educationStudy` OK, `sourceSegmentIds=[]`, warning metadata
16. grpc path decision documented in Step 0 / implementation report
17. FK: `meeting.subject_id REFERENCES subject(id) ON DELETE SET NULL` — no cascade delete meeting

---

## 20. Open risks còn lại

*(Chỉ những gì thực sự chưa xác định từ source tại thời điểm plan — sẽ chốt trong Step 0 implementation)*

1. **grpc_stt_service production reachability:** gRPC server starts when STT adapter available; cần xác nhận deployment config có luồng nào bypass `stt_adapter` segment resolution và chỉ dùng uuid4 từ `grpc_stt_service` — quyết định canonicalize hay exclude guarantee (§5.6, Step 0).

*(OpenAPI scope và realtime education edge đã khóa — không còn là open risk.)*

---

## 21. File change forecast

### meeting-service
- `V16__….sql`, entities/repos/services/controllers/DTOs
- `StudyFolderSubjectMigrationTest.java` + Testcontainers deps
- `Meeting.java`, `MeetingService.java`, `MeetingController.java`

### ai-service
- **New:** `segment_identity.py`, `analysis_versioning.py`, `education_analysis.py`
- **Change:** `pipeline.py`, `analysis_runs.py`, `stt_adapter.py`, `main.py`, `grpc_stt_service.py` (if reachable), `ai_analyzer.py` (thin), schemas
- Tests: segment vectors, cache domain isolation, education normalize

### contracts
- `packages/contracts/meeting-api.yaml`, `ai-api.yaml` (additive)
- regenerated `packages/api-clients/*.ts`

### FE
- `studioRouting.ts` (+ tests), `DashboardLayout.tsx`, `App.tsx`, `useStudioRouteSync.ts`
- `types/subjects.ts`, `types/education.ts`, services, components
- `TranscriptDisplay.tsx`, `transcriptJump.ts`, `transcript.ts` (canonicalize trim-only)

### docs
- `docs/branch-cleanup-report.md` (Stage A)
- `docs/phase1-subject-education-implementation-report.md`

---

*Plan final revision. Implementation starts only after plan acceptance. Stage A is audit-only. Stage B requires explicit user approval for any branch deletion.*
