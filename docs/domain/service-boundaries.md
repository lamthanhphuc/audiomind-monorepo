# Service Ownership & Boundary

## Principles

1. Moi service co ownership ro rang.
2. Khong leak business logic giua cac service.
3. Khong cross-database access.
4. Giao tiep chi qua contract (OpenAPI / Events).

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

## Boundary Rules (Enforced)

1. Khong service nao truy cap DB cua service khac
2. Sync communication -> OpenAPI
3. Async communication -> Event schema
4. Shared types -> packages/shared-kernel

---

## AI Agent Rules

- Meeting logic -> meeting-api
- Workflow/state -> processing-api
- Model/prompt -> ai-api
