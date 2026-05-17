# Plan: Fix Remaining End-to-End Issues — AudioMind

> **Author:** System Architect AI  
> **Date:** 2026-05-09  
> **Status:** COMPLETED
> **Completed At:** 2026-05-09T19:33:00+07:00

---

## 1. Executive Summary

AudioMind's Docker stack starts successfully and individual APIs respond, but the **end-to-end flow** (Upload MP3 → Create Meeting → Process → Transcript + Analysis → Display) is broken due to 6 remaining issues spanning networking, data flow, and dependency management. This plan provides root-cause analysis, prioritized fixes, and execution prompts.

---

## 2. Root-Cause Analysis

### Issue #8 — Frontend skips Meeting creation (CRITICAL — Root cause of #2 and #3)

**Biểu hiện:** Frontend `App.tsx` line 130 generates `meetingId = Date.now()` — a random timestamp — then calls `processAudio()` with that fake ID. No meeting record exists in the database.

**Nguyên nhân gốc:**
- `App.tsx:handleProcess()` calls `uploadAudio()` (which proxies to `ai-api /api/upload-audio`) and gets back `{audio_path, original_filename}`.
- It then immediately calls `processAudio({meeting_id: Date.now(), audio_path})` — **never creating a meeting** via `meeting-api`.
- The `createMeeting()` and `processMeeting()` functions exist in `api.ts` (lines 152-165) but are **never called** in the batch flow.

**Hệ quả trực tiếp:** This single issue causes both Issue #2 (no meeting record) and Issue #3 (processing fails on non-existent meeting_id).

### Issue #2 — Upload doesn't create meeting record

**Nguyên nhân:** The upload endpoint (`processing-api /processing/upload` → `ai-api /api/upload-audio`) only saves the file to disk and returns `{audio_path}`. Neither service creates a meeting record. The `meeting-api /meetings/upload` endpoint (which DOES create a meeting) is never called.

**Hai luồng upload tồn tại song song:**
| Endpoint | Service | Creates Meeting? | Used by Frontend? |
|---|---|:---:|:---:|
| `POST /meetings/upload` | meeting-api (8081) | ✅ Yes | ❌ No |
| `POST /processing/upload` → `POST /api/upload-audio` | processing-api → ai-api | ❌ No | ✅ Yes |

### Issue #3 — `processing/start` fails with non-existent meeting_id

**Nguyên nhân:** `ProcessingService.startProcessing()` calls `assertMeetingAccess()` (line 298-313) which calls `meetingServiceClient.getMeetingById()`. Since the meeting doesn't exist, this throws `404 → ResponseStatusException(NOT_FOUND)`.

Even if we bypass `assertMeetingAccess`, `processMeeting()` (line 128-143) tries to look up the meeting's `audioPath` from the meeting service when no `audio_path` is provided directly. The frontend does provide `audio_path`, but the access check still fails first.

### Issue #4 & #5 — AI containers in wrong Docker network / missing DNS alias

**Nguyên nhân:** The `ai-service/docker-compose.yml` (the standalone file) defines its own `db`, `redis`, `api` (container: `ai-service-gpu`), and `worker` (container: `ai-service-worker`). If someone ran `docker compose up` from `ai-service/`, these containers join `ai-service_default` network — isolated from `infra_default`.

**Tuy nhiên:** In the main `infra/docker-compose.dev.yml`, services `ai-api` and `celery-worker` are defined correctly and DO join `infra_default`. The issue only occurs if someone accidentally starts the standalone AI compose file.

**DNS alias:** `processing-api` connects to `http://ai-api:8000` (line 26 of docker-compose.dev.yml). The `ai-api` service name in `infra/docker-compose.dev.yml` matches this hostname. **But** if the standalone `ai-service/docker-compose.yml` is used instead, the container name is `ai-service-gpu`, causing DNS resolution failure.

### Issue #1 — Worker can't connect to Redis/DB

**Nguyên nhân:** Same root as #4/#5. If `celery-worker` is started via the standalone `ai-service/docker-compose.yml`, it connects to `redis://redis:6379` — but that `redis` resolves to `ai-redis` in `ai-service_default` network, not the shared `redis` in `infra_default`.

When started via `infra/docker-compose.dev.yml`, the `celery-worker` service correctly depends on `redis` and `db` in the same network. The issue is a **deployment procedure problem**.

### Issue #6 — `setuptools` / `pkg_resources`

**Nguyên nhân:** `requirements.txt` now pins `setuptools==68.2.2` (line 42) and the Dockerfile also pins `setuptools==68.2.2` (line 19). This version **does** include `pkg_resources`. 

**Nhưng rủi ro vẫn còn:** If any dependency pulls a newer setuptools transitively, or if pip resolution upgrades it, `pkg_resources` could break again. The safer approach is to replace `pkg_resources` imports with `importlib.metadata` / `importlib.resources`.

---

## 3. Priority Ranking & Dependency Order

```
Fix Order:
┌─────────────────────────────────────────────────────┐
│ Phase 1: Networking (Issues #1, #4, #5)             │
│   → Ensure ALL containers run via infra/compose     │
│   → Delete or mark standalone AI compose as legacy  │
├─────────────────────────────────────────────────────┤
│ Phase 2: Data Flow (Issues #8, #2, #3)              │
│   → Fix frontend to create meeting before process   │
│   → Ensure meeting_id flows correctly end-to-end    │
├─────────────────────────────────────────────────────┤
│ Phase 3: Hardening (Issue #6)                       │
│   → Pin setuptools + add guard import               │
└─────────────────────────────────────────────────────┘
```

**Dependency logic:**
- Phase 1 must be done first: without network connectivity, no inter-service calls work.
- Phase 2 depends on Phase 1: the frontend flow needs `meeting-api`, `processing-api`, and `ai-api` all reachable.
- Phase 3 is independent but low risk — current pin already works.

---

## 4. Proposed Solutions

### Phase 1: Docker Networking (Issues #1, #4, #5)

#### Option A (Recommended): Single Compose Only
1. **Add documentation** in `ai-service/docker-compose.yml` header: `# STANDALONE DEV ONLY — For production/integration, use infra/docker-compose.dev.yml`
2. **Add explicit `container_name`** to `ai-api` and `celery-worker` in `infra/docker-compose.dev.yml` to prevent confusion.
3. **Verify** all services in `infra/docker-compose.dev.yml` share the default network (they already do — no `networks:` override).
4. **Add a startup check script** that warns if any `ai-service_default` containers are running.

#### Option B: External Network
1. Create a shared `audiomind` external network.
2. Add `networks: audiomind:` to both compose files.
3. More complex but allows running AI separately with GPU on a different machine.

**Recommendation:** Option A — simplest, already mostly correct.

**Changes required:**
- `infra/docker-compose.dev.yml`: Add `container_name: ai-api` and `container_name: celery-worker`
- `ai-service/docker-compose.yml`: Add comment header warning against integration use
- `docs/dev-environment-guide.md`: Add clear instruction to ONLY use `infra/docker-compose.dev.yml`

---

### Phase 2: Data Flow (Issues #8, #2, #3)

#### Option A (Recommended): Fix Frontend to use proper flow
The existing APIs already support the correct flow. The frontend just needs to call them in order:

```
1. uploadAudio(file)           → { audio_path }
2. createMeeting()             → { id }  (via meeting-api /api/v1/meetings)
3. processAudio({meeting_id: id, audio_path})  → { status: "queued" }
4. pollUntilCompleted(id)
5. getTranscript(id) + getAnalysis(id)
```

**But there's a subtlety:** `createMeeting()` via `MeetingV1Controller` creates an in-memory `MeetingRecord` (not a DB-persisted `Meeting` entity). The `MeetingController.upload()` creates a DB-persisted entity. And `ProcessingService.assertMeetingAccess()` calls `meetingServiceClient.getMeetingById()` which hits `/meetings/{id}` — the `MeetingController` endpoint that requires a DB entity.

**So the full fix needs:**
1. Frontend calls `POST /meetings/upload` (MeetingController) with file + title → gets back `Meeting` with `id` and `audioPath`
2. Frontend calls `POST /processing/start` with that `meeting_id` (no need for `audio_path` since it's in the DB)
3. OR: Frontend calls `POST /api/v1/meetings` (MeetingV1Controller) → gets ID, then uploads audio separately, then starts processing

**Simplest approach:** Use `MeetingController.upload()` which does both upload + create meeting in one call, then call `processing/start/{meetingId}`.

#### Option B: Make processing-api self-sufficient
Modify `ProcessingService.startProcessing()` to auto-create a meeting when it doesn't exist. More complex, violates service boundaries.

#### Option C: Combined upload+process endpoint
Create a new endpoint in `processing-api` that orchestrates the entire flow. Over-engineering for now.

**Recommendation:** Option A — Fix `App.tsx` to:
1. Upload file via `POST http://localhost:8081/meetings/upload` (meeting-api) with `title` and `file` → returns `Meeting` entity with `.id` and `.audioPath`
2. Call `POST http://localhost:8082/processing/start/{meetingId}` → starts processing
3. Poll `GET http://localhost:8082/processing/status/{meetingId}`
4. Fetch results when completed

#### Authentication Handling (bổ sung)

Tất cả request từ frontend đến `meeting-api` và `processing-api` đều yêu cầu header `Authorization: Bearer <token>`. Token được lưu vào `localStorage` sau khi login thành công (xem `auth.ts` → `setAccessToken()`).

Hiện tại `withTraceHeaders()` trong `api.ts` đã tự động gắn `Authorization` từ `getAccessToken()`. Tuy nhiên, cần đảm bảo:
1. **`getAccessToken()`** trả về token hợp lệ cho mọi request (đã hoạt động ✅).
2. **Thêm hàm `getAuthHeaders()` vào `api.ts`** để các module khác có thể dùng chung khi cần gọi API ngoài `fetchJson` (ví dụ: WebSocket, upload trực tiếp).
3. **Không set `Content-Type` thủ công** khi gửi FormData (browser tự thêm `multipart/form-data` boundary). Nếu set sẽ gây lỗi.

#### CORS Configuration (bổ sung)

Vì frontend chạy ở `localhost:8080` và gọi cross-origin đến `localhost:8081` (meeting-api) và `localhost:8082` (processing-api), các Spring Boot service **phải** cho phép CORS cho origin `http://localhost:8080`.

**Hiện trạng:** Cả `MeetingController` và `ProcessingController` đều có `@CrossOrigin(origins = "${CORS_ALLOWED_ORIGINS:http://localhost:5173}")`. Biến `CORS_ALLOWED_ORIGINS` trong `docker-compose.dev.yml` đã bao gồm `http://localhost:8080` ✅.

**Tuy nhiên**, annotation `@CrossOrigin` chỉ áp dụng cho controller đó. Nếu có endpoint khác hoặc Spring Security chặn preflight `OPTIONS`, CORS sẽ thất bại. Cần kiểm tra và thêm cấu hình global nếu cần:

```java
// Trong SecurityConfig.java hoặc RestConfig.java của mỗi service
@Bean
public WebMvcConfigurer corsConfigurer() {
    return new WebMvcConfigurer() {
        @Override
        public void addCorsMappings(CorsRegistry registry) {
            registry.addMapping("/**")
                .allowedOrigins(
                    "http://localhost:8080",
                    "http://localhost:5173",
                    "http://127.0.0.1:8080"
                )
                .allowedMethods("*")
                .allowedHeaders("*")
                .allowCredentials(true);
        }
    };
}
```

**Lưu ý:** Nếu service dùng Spring Security, cũng cần gọi `http.cors(Customizer.withDefaults())` trong `SecurityFilterChain` để cho phép preflight request đi qua filter chain.

#### Volume Mount Verification (bổ sung)

Sau khi upload thành công, file audio được lưu vào thư mục uploads bên trong container `meeting-api`. Các service khác cần truy cập file này qua shared Docker volume.

Trong `infra/docker-compose.dev.yml`, đảm bảo các service sau có volume `uploads:/app/uploads`:
- `meeting-api` ✅ (đã có)
- `ai-api` ✅ (đã có)
- `celery-worker` ✅ (đã có)
- `processing-api` — **cần kiểm tra**, hiện tại chưa mount volume `uploads`

Kiểm tra nhanh:
```bash
# Xác minh volume mount trên từng container
docker inspect meeting-api --format '{{json .Mounts}}' | jq '.[] | select(.Destination | contains("uploads"))'
docker inspect processing-api --format '{{json .Mounts}}' | jq '.[] | select(.Destination | contains("uploads"))'
docker inspect ai-api --format '{{json .Mounts}}' | jq '.[] | select(.Destination | contains("uploads"))'
```

Nếu `processing-api` thiếu volume mount, thêm vào `infra/docker-compose.dev.yml`:
```yaml
  processing-api:
    volumes:
      - uploads:/app/uploads
```

#### Multipart File Size Configuration (bổ sung)

Để tránh lỗi khi upload file MP3 lớn (>10MB), cấu hình multipart trong `application.yml` của mỗi service:

```yaml
spring:
  servlet:
    multipart:
      max-file-size: 200MB
      max-request-size: 210MB
```

**Hiện trạng:**
- `meeting-service/application.yml`: `max-file-size: 200MB`, `max-request-size: 200MB` ✅
- `processing-service/application.yml`: `max-file-size: 512MB`, `max-request-size: 512MB` ✅

Nếu dùng Spring Boot 2.x, cũng cần:
```yaml
server:
  tomcat:
    max-http-form-post-size: 210MB
```

`meeting-service` đã có `server.tomcat.uri-encoding: UTF-8` nhưng chưa có `max-http-form-post-size`. Cần thêm nếu gặp lỗi upload file lớn.

**Files to modify:**
- `FE-Audiomind/src/App.tsx`: Rewrite `handleProcess()` to use meeting-api upload
- `FE-Audiomind/src/services/api.ts`: Add `uploadToMeetingApi(title, file)` function + `getAuthHeaders()` helper
- `FE-Audiomind/src/services/config.ts`: Already exports `MEETING_API_BASE` ✅
- `demoRecordAUDIOMID/meeting-service/.../SecurityConfig.java`: Verify CORS global config (nếu chưa có)
- `demoRecordAUDIOMID/processing-service/.../SecurityConfig.java`: Verify CORS global config (nếu chưa có)
- `infra/docker-compose.dev.yml`: Thêm volume `uploads` cho `processing-api` (nếu thiếu)

---

### Phase 3: Hardening (Issue #6)

#### Option A (Recommended): Keep pin + add defensive import
```python
# At top of any file using pkg_resources
try:
    import pkg_resources
except ImportError:
    import importlib.metadata as pkg_resources
```
Current pin `setuptools==68.2.2` already works. Add the fallback as insurance.

#### Option B: Replace all `pkg_resources` usage
Find all imports and replace with `importlib.metadata`. More work, but future-proof.

**Recommendation:** Option A for now. Grep for `pkg_resources` usage first.

---

## 5. End-to-End Success Criteria

| # | Criterion | Verification Method |
|---|-----------|-------------------|
| 1 | Upload MP3 file successfully | `POST /meetings/upload` returns `200` with `Meeting.id` |
| 2 | Meeting record created in DB | `GET /meetings/{id}` returns meeting with `audioPath` |
| 3 | Processing job queued | `POST /processing/start/{id}` returns `status: QUEUED` |
| 4 | Job transitions: QUEUED → RUNNING → COMPLETED | Poll `GET /processing/status/{id}` |
| 5 | Transcript has content | `GET /processing/transcript/{id}` returns non-empty `transcripts[]` |
| 6 | Analysis has keywords | `GET /processing/{id}/analysis` returns non-empty `keywords[]` |
| 7 | Frontend displays results | Browser at `localhost:8080` shows transcript + summary |

**Smoke Test Command Sequence:**
```bash
# ============================================================
# ⚠️  RESET STATE (chỉ dùng cho dev/test — KHÔNG dùng cho prod)
# ============================================================
# Xóa tất cả job state trong Redis
docker exec redis redis-cli FLUSHALL

# Xóa meeting cũ trong DB (PostgreSQL)
docker exec db psql -U audiomind -d audiomind \
  -c "TRUNCATE TABLE meeting RESTART IDENTITY CASCADE;"

# ============================================================
# Kiểm tra database schema
# ============================================================
# Xác minh bảng meeting có cột audio_path
docker exec db psql -U audiomind -d audiomind -c "\d meeting" | grep -q audio_path \
  && echo "✅ audio_path column exists" \
  || echo "❌ Missing audio_path column — run: ALTER TABLE meeting ADD COLUMN audio_path VARCHAR(255);"

# ============================================================
# Kiểm tra Ollama model đã sẵn sàng
# ============================================================
# Liệt kê model đã pull
docker exec ollama-service ollama list

# Nếu chưa có qwen2.5:3b-instruct, pull về (có thể mất 5-15 phút):
# docker exec ollama-service ollama pull qwen2.5:3b-instruct

# ============================================================
# E2E Smoke Test
# ============================================================

# 1. Login
TOKEN=$(curl -s -X POST http://localhost:8083/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e_test_user","password":"Test@123456"}' | jq -r '.accessToken')

# 2. Upload + Create Meeting
MEETING=$(curl -s -X POST http://localhost:8081/meetings/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "title=Test Meeting" \
  -F "file=@test-audio.wav")
MEETING_ID=$(echo $MEETING | jq '.id')
AUDIO_PATH=$(echo $MEETING | jq -r '.audioPath')
echo "Created meeting: $MEETING_ID"
echo "Audio path: $AUDIO_PATH"

# 2b. Xác minh file audio có thể truy cập từ processing-api container
#     (kiểm tra volume mount uploads hoạt động đúng)
docker exec processing-api test -f "$AUDIO_PATH" \
  && echo "✅ Audio file accessible from processing-api" \
  || echo "❌ Audio file NOT accessible — check volume mount 'uploads' in docker-compose.dev.yml"

# 3. Start Processing  
curl -s -X POST http://localhost:8082/processing/start/$MEETING_ID \
  -H "Authorization: Bearer $TOKEN"

# 4. Poll Status (lặp lại cho đến khi COMPLETED hoặc FAILED)
curl -s http://localhost:8082/processing/status/$MEETING_ID \
  -H "Authorization: Bearer $TOKEN"

# 5. Get Transcript
curl -s http://localhost:8082/processing/transcript/$MEETING_ID \
  -H "Authorization: Bearer $TOKEN"

# 6. Get Analysis
curl -s http://localhost:8082/processing/$MEETING_ID/analysis \
  -H "Authorization: Bearer $TOKEN"
```

---

## 6. Execution Prompts

### Prompt 1: Phase 1 — Fix Docker Networking

```
## Task: Fix Docker Networking for AudioMind

### Context
The AudioMind monorepo has two Docker Compose files:
1. `infra/docker-compose.dev.yml` (main orchestration — CORRECT)
2. `demoRecordAUDIOMID/ai-service/docker-compose.yml` (standalone — CAUSES ISSUES)

When the standalone file is used, AI containers join `ai-service_default` network 
instead of `infra_default`, causing DNS resolution failures for `redis`, `db`, 
and `ai-api`.

### Changes Required

1. **`infra/docker-compose.dev.yml`**: Add explicit `container_name` to `ai-api` 
   and `celery-worker` services for clarity.

2. **`demoRecordAUDIOMID/ai-service/docker-compose.yml`**: Add a comment block 
   at the top warning this is standalone-only and should NOT be used for 
   integration testing.

3. **`docs/dev-environment-guide.md`**: Add a section "Running the Full Stack" 
   that explicitly states to use `docker compose -f infra/docker-compose.dev.yml up`.

### Verification
- Run `docker compose -f infra/docker-compose.dev.yml up -d`
- Verify all containers are in the same network: 
  `docker network inspect infra_default`
- Verify `celery-worker` can reach redis: 
  `docker exec <celery-worker> python -c "import redis; r=redis.from_url('redis://redis:6379/0'); r.ping()"`
- Verify `processing-api` can reach `ai-api`: 
  `docker exec <processing-api> curl -s http://ai-api:8000/health`
```

---

### Prompt 2: Phase 2 — Fix Frontend Upload Flow + Authentication

```
## Task: Fix Frontend Upload Flow to Create Meeting Records

### Context
File: `FE-Audiomind/src/App.tsx`

Current broken flow (line 118-173):
1. uploadAudio(file) → ai-api saves file, returns {audio_path}
2. processAudio({meeting_id: Date.now(), audio_path}) → FAILS because 
   meeting_id doesn't exist in DB

### Required New Flow
1. Upload file to meeting-api: POST http://localhost:8081/meetings/upload 
   with FormData {title: file.name, file: file}
   → Returns Meeting entity: {id, title, audioPath, ...}
2. Start processing: POST http://localhost:8082/processing/start/{meetingId}
   → Returns {meetingId, status: "QUEUED"}
3. Poll: GET http://localhost:8082/processing/status/{meetingId}
4. Fetch results: GET transcript + analysis

IMPORTANT: Tất cả request phải gửi kèm header `Authorization: Bearer <token>`.
Token được lấy từ `getAccessToken()` (lưu trong localStorage sau khi login).

### Files to Modify

#### 1. `FE-Audiomind/src/services/api.ts`

Thêm helper `getAuthHeaders()` để dùng chung:
```typescript
/**
 * Returns standard auth + trace headers for API calls.
 * Use this when calling APIs outside of fetchJson (e.g. WebSocket, direct fetch).
 */
export const getAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {}
  const accessToken = getAccessToken()
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`
  }
  headers['x-trace-id'] = createTraceId()
  headers['x-request-id'] = headers['x-trace-id']
  return headers
}
```

Thêm các hàm upload/processing mới:
```typescript
export const uploadToMeetingApi = async (
  title: string, file: File
): Promise<{id: number; audioPath: string}> => {
  const body = new FormData()
  body.append('title', title)
  body.append('file', file)
  // KHÔNG set Content-Type thủ công — browser tự thêm multipart boundary
  return fetchJson<{id: number; audioPath: string}>(
    `${MEETING_API_BASE}/meetings/upload`,
    { method: 'POST', body }
  )
}

export const startProcessingByPath = async (meetingId: number) => {
  return fetchJson<Record<string, unknown>>(
    `${PROCESSING_API_BASE}/processing/start/${meetingId}`,
    { method: 'POST' }
  )
}
```

Lưu ý: `fetchJson` đã gọi `withTraceHeaders()` bên trong, mà hàm đó đã tự
đọc `getAccessToken()` và gắn header `Authorization`. Nên KHÔNG cần truyền
header auth thủ công khi dùng `fetchJson`.

#### 2. `FE-Audiomind/src/App.tsx`
Replace handleProcess() (lines 118-174):
- Remove: `const meetingId = Date.now()`
- Remove: `uploadAudio(selectedFile)` 
- Remove: `processAudio({meeting_id: meetingId, audio_path: upload.audio_path})`
- Add: `const meeting = await uploadToMeetingApi(selectedFile.name, selectedFile)`
- Add: `const meetingId = meeting.id`
- Add: `await startProcessingByPath(meetingId)`
- Keep polling and result fetching logic, using `meetingId` from meeting response
- Thêm error handling cho trường hợp token hết hạn (401) → redirect về login

Thêm hiển thị lỗi rõ ràng trên UI:
```typescript
// Thêm state trong App.tsx
const [errorMessage, setErrorMessage] = useState<string | null>(null)

// Trong handleProcess, bọc vào try-catch và set error rõ ràng
try {
  // ... upload, process
  setErrorMessage(null)
} catch (error: any) {
  const message = error.status === 401 
    ? 'Phiên đăng nhập hết hạn, vui lòng đăng nhập lại'
    : error.status === 413 
    ? 'File quá lớn (tối đa 200MB)'
    : error.status === 415
    ? 'Định dạng file không được hỗ trợ'
    : error.message || 'Lỗi không xác định, vui lòng thử lại'
  setErrorMessage(message)
  console.error('handleProcess error:', error)
}

// Render error message trên UI
{errorMessage && (
  <div className="error-banner" style={{
    padding: '12px 16px',
    background: '#fee2e2',
    color: '#991b1b',
    borderRadius: 8,
    marginTop: 12
  }}>
    {errorMessage}
  </div>
)}
```

#### 3. Retry logic cho polling (bổ sung)

Hàm `pollUntilCompleted()` hiện tại sẽ throw ngay khi gặp lỗi mạng hoặc 5xx.
Cần bọc mỗi lần poll trong retry logic để chịu lỗi tạm thời:

```typescript
/**
 * Poll with automatic retry on transient errors (network, 5xx).
 * Throws immediately on 4xx (client errors) — no retry.
 */
const pollWithRetry = async (
  meetingId: number,
  retries = 3,
  delay = 2000
): Promise<ReturnType<typeof getProcessingStatus>> => {
  for (let i = 0; i < retries; i++) {
    try {
      return await getProcessingStatus(meetingId)
    } catch (error) {
      // Không retry lỗi 4xx (auth, not found, etc.)
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        throw error
      }
      if (i === retries - 1) throw error
      console.warn(`Polling failed, retrying in ${delay}ms...`, error)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Unreachable')
}
```

Sau đó, trong `pollUntilCompleted()`, thay `getProcessingStatus(meetingId)`
bằng `pollWithRetry(meetingId)` để mỗi vòng poll tự retry khi gặp lỗi tạm.

### Verification
- Login at localhost:8080
- Select an MP3 file and click "Phân tích file"
- Kiểm tra Network tab: request đến /meetings/upload có header Authorization
- Status should progress: uploading → processing → completed
- Transcript and summary should appear
- Test edge case: logout rồi thử upload → phải redirect về login
```

---

### Prompt 3: Phase 3 — Harden setuptools/pkg_resources

```
## Task: Harden pkg_resources Import in AI Service

### Context
File: `demoRecordAUDIOMID/ai-service/requirements.txt` pins `setuptools==68.2.2` 
which includes `pkg_resources`. But transitive upgrades could break this.

### Changes Required

1. **Find all `pkg_resources` imports** in `demoRecordAUDIOMID/ai-service/`:
   ```bash
   grep -r "import pkg_resources" demoRecordAUDIOMID/ai-service/
   ```

2. **For each file**, wrap the import:
   ```python
   try:
       import pkg_resources
   except ImportError:
       import importlib.metadata as pkg_resources
   ```

3. **Pin setuptools in requirements.txt** (already done: `setuptools==68.2.2`)

4. **Pin setuptools in Dockerfile** (already done: line 19)

5. **Add a constraints.txt guard**:
   In `demoRecordAUDIOMID/ai-service/constraints.txt`, add:
   ```
   setuptools==68.2.2
   ```
   And modify Dockerfile pip install to use: `pip install -c constraints.txt`

### Verification
- Build AI service: `docker compose -f infra/docker-compose.dev.yml build ai-api`
- Start and check logs: no `ModuleNotFoundError: pkg_resources`
- Run: `docker exec <ai-api> python -c "import pkg_resources; print('OK')"`
```

---

## 7. Pre-flight Checklist: Ollama Model

Trước khi chạy E2E test, **bắt buộc** kiểm tra model Ollama đã sẵn sàng:

```bash
# Kiểm tra model đã pull chưa
docker exec ollama-service ollama list

# Kết quả mong đợi: có dòng chứa "qwen2.5:3b-instruct"
# Nếu KHÔNG có, chạy:
docker exec ollama-service ollama pull qwen2.5:3b-instruct
# (mất khoảng 5-15 phút tùy mạng, model ~2GB)
```

**Script tự động (tùy chọn):** Tạo file `scripts/check-ollama-model.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

MODEL="qwen2.5:3b-instruct"
CONTAINER="ollama-service"

echo "Checking if model '$MODEL' is available in $CONTAINER..."
if docker exec "$CONTAINER" ollama list 2>/dev/null | grep -q "$MODEL"; then
  echo "✅ Model '$MODEL' is ready."
else
  echo "⚠️  Model '$MODEL' not found. Pulling now..."
  docker exec "$CONTAINER" ollama pull "$MODEL"
  echo "✅ Model '$MODEL' pulled successfully."
fi
```

---

## 7b. How to Apply Fixes & Restart Services

Sau khi sửa code, cần rebuild và restart container tương ứng.

### Frontend (React)
```bash
# Rebuild Docker image cho web service
docker compose -f infra/docker-compose.dev.yml build web
docker compose -f infra/docker-compose.dev.yml up -d web

# Hoặc nếu chạy dev ngoài Docker:
cd FE-Audiomind
npm run build
```

### Backend Java (meeting-api, processing-api)
```bash
# Rebuild + restart từng service
docker compose -f infra/docker-compose.dev.yml build meeting-api
docker compose -f infra/docker-compose.dev.yml up -d meeting-api

docker compose -f infra/docker-compose.dev.yml build processing-api
docker compose -f infra/docker-compose.dev.yml up -d processing-api
```

### AI Service (Python)
```bash
docker compose -f infra/docker-compose.dev.yml build ai-api celery-worker
docker compose -f infra/docker-compose.dev.yml up -d ai-api celery-worker
```

### Restart all (clean slate)
```bash
docker compose -f infra/docker-compose.dev.yml down
docker compose -f infra/docker-compose.dev.yml up -d
```

---

## 7c. Debugging: When E2E Fails

| Symptom | Likely Culprit | Debug Command |
|---------|---------------|----------------|
| `401 Unauthorized` on `/meetings/upload` | Token invalid or expired | `docker logs meeting-api \| grep -i "unauthorized\|401"` |
| `403 Forbidden` on CORS preflight | CORS not configured | `docker logs meeting-api \| grep -i "cors"` |
| `404 Not Found` on `/processing/start/{id}` | Meeting ID doesn't exist in DB | `docker logs processing-api \| grep "Meeting not found"` |
| Job stuck in `QUEUED` forever | Celery worker not running or Redis down | `docker logs celery-worker --tail 50; docker exec redis redis-cli ping` |
| Job fails with `ModuleNotFoundError` | setuptools pin missing | `docker logs ai-api \| grep pkg_resources` |
| Job fails with Ollama model error | Model not pulled | `docker exec ollama-service ollama list; docker logs ollama-service --tail 30` |
| `413 Payload Too Large` on upload | Multipart size limit too small | Kiểm tra cấu hình multipart trong `application.yml` |
| `500` with "audio file not found" | Volume mount missing | `docker inspect processing-api \| grep -A5 Mounts` |
| `415 Unsupported Media Type` | File extension not allowed | Kiểm tra `ALLOWED_EXTENSIONS` trong MeetingController hoặc ai-service config |

---

## 8. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Meeting-api upload endpoint may need auth header forwarding | Processing start will fail if auth not passed correctly | Test with curl first before frontend changes |
| Ollama model not pulled yet | Processing will hang at LLM analysis step | Chạy `scripts/check-ollama-model.sh` hoặc lệnh thủ công trước khi test |
| Large MP3 files may timeout during upload | HTTP 504/timeout | Kiểm tra multipart config (Section 4, Phase 2) và nginx proxy timeout |
| Redis data from previous broken runs may interfere | Stale job states | Chạy lệnh reset trong Smoke Test (Section 5) trước khi test |
| Whisper model download on first run takes time | First processing job will be slow | Pre-download in Dockerfile or accept first-run delay |
| Token hết hạn giữa chừng processing | Frontend polling gặp 401 | Thêm error handling trong `pollUntilCompleted()` để phát hiện 401 |
| Volume mount uploads không shared đúng | File uploaded bởi meeting-api không thấy bởi ai-api/worker | Kiểm tra volume mount (Section 4, Phase 2) |

---

## 9. Estimated Effort

| Phase | Effort | Files Changed |
|-------|--------|--------------|
| Phase 1: Networking | ~30 min | 3 files |
| Phase 2: Data Flow + Auth + CORS + Multipart + Volume + Retry | ~4-5 hours | 6-7 files |
| Phase 3: Hardening | ~20 min | 2-3 files |
| Ollama Model Check Script | ~10 min | 1 file |
| Frontend Error UI | ~30 min | 1 file |
| E2E Verification + Debugging | ~30 min | 0 files |
| **Total** | **~6-7 hours** | **~13-15 files** |
