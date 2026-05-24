# Phase 7B — Health Check & Service Readiness

## 1. Status
- SPEC-ONLY
- Branch: chore/backend-health-checks-spec
- Date: 2026-05-24
- Không implement code trong branch này
- CodeGraph note: `codegraph affected` hiện tại trả về `No files provided. Use file arguments or --stdin.` khi chạy không có tham số

## 2. Link to Phase 7A
- Phase 7B được materialize từ health/readiness section của Phase 7A (`docs/specs/backend-demo-hardening.md`).
- Scope chỉ gồm health/readiness contract và docker compose healthcheck plan.
- Out of scope cho 7B: error response standardization, logging overhaul, analysis reliability hardening, multi STT investigation/implementation.

## 3. Current state

| Service | Current /health | Current /ready | Dependencies checked | Gaps |
| ------- | --------------- | -------------- | -------------------- | ---- |
| processing-api | Có, trả `{"status":"ok","service":"processing-service"}` | Có, trả `{"status":"ready","service":"processing-service"}` | Redis `ping()` + ai-api `/health` qua `AIServiceClient.health()` | Ready fail hiện tại không map 503, khả năng ra 500 (exception chung). Chưa có per-check detail trong response. |
| ai-api | Có, trả `status`, runtime/device/model flags, registry (không trả key raw) | Có, check DB `SELECT 1`, Redis `ping`, `pipeline != None`; trả `{"status":"ready","service":"ai-service",...}` | DB + Redis + pipeline in-memory | Fail do DB/Redis có khả năng 500; 503 chỉ rõ cho trường hợp `pipeline is None`. Chưa có response `checks` rõ từng dependency. Chưa có boolean readiness cho `deepgramConfigured`/`geminiConfigured`. |
| meeting-api | Có, trả `{"status":"ok","service":"meeting-service"}` | Có, trả `{"status":"ready","service":"meeting-service"}` | DB qua `meetingRepository.count()` | Ready fail hiện tại khả năng 500, chưa chuẩn 503; chưa có chi tiết check. |
| user-api | Có, trả `{"status":"ok","service":"user-service"}` | Có, hiện tại trả ready tĩnh, không check dependency | Không check dependency trong `/ready` | Gap lớn nhất: `/ready` không xác minh DB/Redis dù service phụ thuộc db/redis trong compose. |
| db | Không có app endpoint | Không có app endpoint | N/A | Chưa có compose `healthcheck` (`pg_isready`). |
| redis | Không có app endpoint | Không có app endpoint | N/A | Chưa có compose `healthcheck` (`redis-cli ping`). |

## 4. Goals
- Liveness rõ ràng.
- Readiness rõ ràng.
- Docker compose hiển thị health status cho core services.
- Debug demo nhanh.
- Không expose secret.
- Không để optional service làm hỏng core demo startup.

## 5. Non-goals
- Không sửa FE.
- Không sửa STT/Deepgram/Gemini behavior.
- Không sửa analysis endpoint business logic.
- Không làm error response standardization toàn hệ thống trong 7B.
- Không đổi business API contract ngoài health/readiness.
- Không đổi DB schema.
- Không optimize performance.

## 6. Health vs readiness contract

Định nghĩa:
- `/health`: app process alive, lightweight, không phụ thuộc downstream nặng.
- `/ready`: app có thể phục vụ request demo, được phép check required dependencies.

HTTP behavior:
- `/health` OK: 200
- `/ready` OK: 200
- `/ready` fail: 503

Target response shape:

```json
{
  "status": "UP",
  "service": "processing-api",
  "timestamp": "2026-05-24T00:00:00Z",
  "checks": {
    "redis": "UP",
    "aiApi": "UP"
  }
}
```

Fail example:

```json
{
  "status": "DOWN",
  "service": "processing-api",
  "timestamp": "2026-05-24T00:00:00Z",
  "checks": {
    "redis": "UP",
    "aiApi": "DOWN"
  }
}
```

## 7. Service-by-service implementation plan

### 7.1 processing-api
Plan:
- `/health`: app alive only.
- `/ready`: check Redis/job state và ai-api reachable.
- Timeout ngắn cho ai-api check.
- Không check Gemini/Deepgram trực tiếp.
- Ready fail trả 503.
- Không expose secret.

Acceptance:
- Redis down => `/ready` 503.
- ai-api down => `/ready` 503.
- `/health` vẫn 200 nếu process alive.

### 7.2 ai-api
Plan:
- `/health`: app alive only.
- `/ready`: check lightweight dependencies/config.
- Return non-secret booleans:
  - `deepgramConfigured`
  - `geminiConfigured`
  - `redis`/`db` status nếu service dùng trực tiếp
  - `analysisProviderReady` nếu check được nhẹ
- Ready fail trả 503.
- Không call provider network nặng trong readiness nếu có thể gây chậm/flaky.

Acceptance:
- Missing Gemini key => ready response rõ ràng, không lộ key.
- Missing Deepgram key => ready response rõ ràng, không lộ key.
- `/health` vẫn 200 nếu app alive.

### 7.3 meeting-api
Plan:
- `/health`: app alive.
- `/ready`: check DB (và Redis nếu service phát sinh phụ thuộc).
- Ready fail trả 503.
- Response shape gần giống services khác.

### 7.4 user-api
Plan:
- `/health`: app alive.
- `/ready`: bổ sung check DB/Redis theo dependency thực tế.
- Ready fail trả 503.
- Response shape gần giống services khác.

### 7.5 db / redis
Plan:
- Docker healthcheck:
  - db: dùng `pg_isready` nếu image Postgres hỗ trợ.
  - redis: dùng `redis-cli ping` nếu image Redis hỗ trợ.
- Không cần app endpoint.

## 8. Docker compose healthcheck plan

Phân tích hiện tại:
- `infra/docker-compose.dev.yml` chưa có khối `healthcheck` cho các service core.
- `depends_on` hiện tại là startup-order cơ bản, chưa dùng `condition: service_healthy`.
- Optional services (`ollama-service`, `whisper-service`, `diarization-service`, `processing-service` cho AI processing) cần tránh chặn core demo startup.

Đề xuất:
- Command phải phù hợp image hiện tại.
- Nếu image không có curl/wget, ưu tiên phương án ít rủi ro:
  - dùng wget nếu có
  - dùng Python one-liner nếu image có Python
  - chỉ sửa Dockerfile nếu thật cần thiết (ghi follow-up)
- Thêm `depends_on: condition: service_healthy` cho required dependencies nếu compose tooling hỗ trợ.
- Không để optional services chặn core startup nếu không cần cho luồng demo chính.

### Java runtime image healthcheck decision

Không được giả định Java runtime image có sẵn `curl` hoặc `wget`.

Trước khi chọn healthcheck command cuối cùng cho Java services, phải kiểm tra trong container:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml run --rm processing-api sh -lc "command -v curl || command -v wget || true"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml run --rm meeting-api sh -lc "command -v curl || command -v wget || true"
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml run --rm user-api sh -lc "command -v curl || command -v wget || true"
```

Nếu không có `curl`/`wget`:
- Option A: thêm `curl` vào runtime image nếu base image hỗ trợ package manager và thay đổi đủ nhỏ.
- Option B: dùng `wget` nếu base image có `busybox`/`wget`.
- Option C: dùng app-level lightweight health command không cần thêm package, chỉ khi khả thi.

Không chọn healthcheck command cuối cùng cho Java services trước khi xác minh image thật.

| Service | Healthcheck command proposal | Interval | Timeout | Retries | Depends on |
| ------- | ---------------------------- | -------- | ------- | ------- | ---------- |
| ai-api | `python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=2)"` | 10s | 3s | 5 | db (healthy), redis (healthy). Ollama để optional theo demo mode. |
| processing-api | Chưa chọn command cuối cùng. Cần xác minh runtime image có curl/wget trước; nếu không có thì cân nhắc bổ sung curl vào Dockerfile hoặc dùng phương án nhẹ tương đương. | 10s | 3s | 5 | ai-api (healthy), meeting-api (healthy), redis (healthy) |
| meeting-api | Chưa chọn command cuối cùng. Cần xác minh runtime image có curl/wget trước; nếu không có thì cân nhắc bổ sung curl vào Dockerfile hoặc dùng phương án nhẹ tương đương. | 10s | 3s | 5 | db (healthy) |
| user-api | Chưa chọn command cuối cùng. Cần xác minh runtime image có curl/wget trước; nếu không có thì cân nhắc bổ sung curl vào Dockerfile hoặc dùng phương án nhẹ tương đương. | 10s | 3s | 5 | db (healthy), redis (healthy) |
| db | `pg_isready -U ${POSTGRES_USER:-audiomind} -d ${POSTGRES_DB:-audiomind}` | 10s | 5s | 5 | N/A |
| redis | `redis-cli ping` | 10s | 3s | 5 | N/A |

## 9. Test plan

Java targeted tests:
- processing-service HealthController test (tạo mới)
- meeting-service HealthController test nếu cần (tạo mới)
- user-service HealthController test nếu cần (tạo mới)

AI service tests:
- pytest cho `/health`
- pytest cho `/ready`
- ready fail path bằng mock missing config/dependency nếu khả thi

Docker smoke:
- build selected services
- up force recreate selected services
- docker compose ps
- curl health/ready endpoints

Không chạy full test suite trừ khi cần.

## 10. Validation commands

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml build ai-api processing-api meeting-api user-api
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml up -d --force-recreate ai-api processing-api meeting-api user-api
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml ps
curl -fsS http://localhost:8082/health
curl -fsS http://localhost:8082/ready
curl -fsS http://localhost:8000/health
curl -fsS http://localhost:8000/ready
curl -fsS http://localhost:8081/health
curl -fsS http://localhost:8081/ready
curl -fsS http://localhost:8083/health
curl -fsS http://localhost:8083/ready
```

Java:

```powershell
cd D:\Bin\EXE101\phase3-worktree\demoRecordAUDIOMID
.\mvnw.cmd -pl processing-service -am "-Dtest=HealthControllerTest" test --no-transfer-progress
.\mvnw.cmd -pl meeting-service -am "-Dtest=HealthControllerTest" test --no-transfer-progress
.\mvnw.cmd -pl user-service -am "-Dtest=HealthControllerTest" test --no-transfer-progress
```

Python:

```bash
python -m pytest -q demoRecordAUDIOMID/ai-service/tests/test_health.py
ruff check demoRecordAUDIOMID/ai-service
black --check demoRecordAUDIOMID/ai-service
```

## 11. Recommended decisions for implementation
- processing-api `/ready` nên check ai-api `/ready`, không phải `/health`, vì processing cần biết ai-api thật sự sẵn sàng xử lý pipeline/demo request.
- ai-api `/ready` trong demo profile nên fail 503 nếu thiếu required config cho demo path:
  - Deepgram key nếu upload/realtime STT cần Deepgram.
  - Gemini key nếu Gemini structured analysis là bắt buộc trong demo.
- Nếu muốn local dev không bị block do thiếu key, dùng env/config flag rõ ràng như `REQUIRE_AI_PROVIDER_KEYS_FOR_READY=true|false`, mặc định cho demo là `true`.
- `/health` tuyệt đối không fail vì thiếu provider key; `/health` chỉ kiểm tra app alive.

## 12. Risks and decisions before coding
- Có nên dùng Spring Actuator hay giữ custom controller?
- Có nên chuẩn hóa response shape toàn bộ service ngay trong 7B không?
- Readiness nên fail nếu Gemini/Deepgram key missing không?
- processing-api readiness check ai-api qua `/health` hay `/ready`?
- Docker healthcheck dùng curl/wget/python phụ thuộc image hiện tại (đặc biệt Java runtime image).
- `depends_on: service_healthy` có tương thích compose version/tooling hiện tại không?

## 13. Implementation slices after this spec
- 7B-1: ai-api health/ready tests + endpoint cleanup
- 7B-2: Spring services health/ready parity
- 7B-3: docker compose healthcheck
- 7B-4: documentation/debug guide update

## 14. Acceptance criteria for Phase 7B implementation PR
- Core services có `/health` và `/ready`.
- `/health` lightweight, không fail do downstream unavailable.
- `/ready` fail 503 khi required dependency unavailable.
- Response không expose secret.
- Docker compose hiển thị health status cho core services.
- Manual curl commands pass khi stack healthy.
- Targeted tests pass.
- Không sửa FE/STT/Gemini/analysis business logic.

## Appendix A - Evidence snapshot (spec-only analysis)
- processing-api: `/ready` gọi Redis ping + ai-api `/health`.
- ai-api: `/ready` check DB + Redis + `pipeline` tồn tại, nhưng fail không đồng nhất 503.
- meeting-api: `/ready` check DB bằng repository count.
- user-api: `/ready` chưa check dependency.
- docker-compose: chưa có `healthcheck` cho core services/db/redis.
