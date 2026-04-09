# REVIEW_FIX

## Critical (fix ngay)
- [x] K8s secrets: thay placeholder trong `k8s/base/secret.yaml` bằng giá trị thật qua SealedSecret/External Secret, không commit secret thô.
- [x] Bổ sung Redis runtime cho K8s (StatefulSet + Service) và kiểm tra service discovery `redis:6379`.
- [x] Bổ sung Celery worker deployment cho K8s để xử lý async jobs tách khỏi API pod.
- [x] Bật TLS tại Istio Gateway (`k8s/istio/gateway-and-routing.yaml`) và cấu hình secret `audiomind-tls`.
- [x] Ép production DB thật cho meeting-service, bỏ fallback H2 in-memory và `ddl-auto: update`.
- [x] Thay test placeholder bằng test nghiệp vụ cho meeting-service và processing-service.

## Major
- [x] Chuẩn hóa config production: bỏ default localhost/secrets rỗng trong `demoRecordAUDIOMID/ai-service/app/config.py`.
- [x] Thêm global exception handler cho Java và Python service để chuẩn hóa response lỗi + trace ID.
- [x] Refactor job state ở processing-service: Redis là single source of truth, bỏ trùng lặp trạng thái in-memory.
- [x] Tăng và externalize timeout/retry cho upstream AI call trong processing-service.
- [x] Nâng cấp health endpoint thành readiness check (DB/Redis/upstream).
- [x] Triển khai auth thật cho FE thay login mock; gắn token vào API request.
- [x] Đồng bộ biến môi trường FE giữa README, `.env.example`, và code.
- [x] Loại hardcoded local file path trong Playwright test để chạy được trong CI.

## Minor
- [ ] Chạy container bằng non-root user trong toàn bộ Dockerfile.
- [ ] Chuẩn hóa structured logging (JSON + trace IDs) và chính sách retention.
- [ ] Rà soát lại upload limits/rate-limit cho mọi entry point.
- [ ] Thêm CI gates cho dependency scan, container scan, và env-config validation.

## Refactor đề xuất
- [ ] Tạo utility chung cho upload validation (size, extension, safe path) dùng lại giữa services.
- [ ] Tạo error contract chung (`code`, `message`, `traceId`, `details`) cho toàn bộ API.
- [ ] Tạo config schema chung + startup validation để fail-fast khi thiếu biến môi trường.
- [ ] Tách HTTP client config (timeout/retry/circuit-breaker) thành module chuẩn dùng chung.
