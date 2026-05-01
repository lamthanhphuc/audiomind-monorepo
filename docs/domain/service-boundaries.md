# Service Ownership & Boundary

## Principles

1. Moi service co ownership ro rang.
2. Khong leak business logic giua cac service.
3. Khong cross-database access.
4. Giao tiep chi qua contract (OpenAPI / Events).
5. Realtime path phai qua gateway va event contract, khong bypass authorization flow.

---

## meeting-api

### Ownership
- Meeting metadata
- Audio storage reference
- Meeting lifecycle

### Allowed
- CRUD meeting
- Trigger processing job

### Forbidden
- Khong chua AI logic
- Khong goi model provider

---

## processing-api (orchestrator)

### Ownership
- Workflow orchestration
- State machine
- Retry policy
- Job timeline

### Allowed
- Goi ai-api
- Update trang thai job

### Forbidden
- Khong implement STT/diarization/summarization logic

---

## ai-api

### Ownership
- AI pipeline execution
- Model adapters
- Prompt handling

### Allowed
- STT / diarization / summarization

### Forbidden
- Khong quan ly workflow tong
- Khong luu state dai han (uu tien stateless)

---

## realtime-gateway

### Ownership
- Browser-facing realtime channel (WebSocket)
- Bridge audio/event streaming giua frontend va backend services
- Session authorization va reconnect handling

### Allowed
- Xac thuc ket noi theo meeting/user context
- Forward stream envelopes qua gRPC
- Broadcast transcript.partial / keyword.hit cho client

### Forbidden
- Khong implement domain AI scoring/analyzer logic
- Khong ghi truc tiep business data vao database service khac

---

## glossary-service

### Ownership
- Glossary term CRUD
- Versioning glossary
- Cache invalidation/broadcast cho consumers

### Allowed
- Cap term metadata/synonym/domain config cho AI pipeline
- Phat hanh version hash cho realtime consumers

### Forbidden
- Khong xu ly luong orchestrator state
- Khong thay the processing-api cho workflow control

---

## Boundary Rules (Enforced)

1. Khong service nao truy cap DB cua service khac
2. Sync communication -> OpenAPI
3. Async communication -> Event schema
4. Shared contracts -> packages/contracts
5. Generated client/shared API bindings -> packages/api-clients

---

## Realtime Data Flow (Summary)

1. FE gui/nhan realtime qua `realtime-gateway` (WebSocket).
2. Gateway trao doi streaming voi STT/AI services qua gRPC.
3. Events duoc chuan hoa theo contracts (`packages/contracts/*.proto`).
4. processing-api van la orchestrator cho lifecycle va status/job state.

---

## AI Agent Rules

- Meeting logic -> meeting-api
- Workflow/state -> processing-api
- Model/prompt -> ai-api
- Realtime transport/session -> realtime-gateway
- Glossary CRUD/version -> glossary-service
