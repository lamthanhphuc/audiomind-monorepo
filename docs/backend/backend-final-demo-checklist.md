# Backend Final Demo Checklist

## 1. Metadata

- Date:
- Branch:
- Commit:
- Tester:
- Environment:

## 2. Repo state

- [ ] Correct branch
- [ ] Working tree clean before final run
- [ ] No `.env` changes staged
- [ ] No debug/log/zip/audio artifacts
- [ ] No unintended FE/infra changes

## 3. Tests and lint

- [ ] FE tests pass
- [ ] FE build pass
- [ ] ai-service pytest pass
- [ ] ruff pass
- [ ] black --check pass
- [ ] processing-service targeted tests pass
- [ ] meeting-service targeted tests pass
- [ ] user-service targeted tests pass

## 4. Docker deploy smoke

- [ ] docker compose config pass
- [ ] selected service build pass
- [ ] up -d --force-recreate pass
- [ ] docker compose ps shows target services Up

## 5. Health and readiness

| Service | URL | Expected | Result | Notes |
| ------- | --- | -------- | ------ | ----- |
| processing-api | http://localhost:8082/ready | 200 | | |
| ai-api | http://localhost:8000/ready | 200 | | |
| meeting-api | http://localhost:8081/ready | 200 | | |
| user-api | http://localhost:8083/ready | 200 | | |
| web | http://localhost:8080 | 200/browser opens | | |

## 6. Upload smoke

- [ ] Upload vi -> transcript not empty -> analysis visible
- [ ] Upload en -> transcript not empty -> analysis visible
- [ ] Upload multi -> transcript not empty -> analysis visible, quality noted

## 7. Realtime smoke

- [ ] Realtime vi -> transcript saved -> analysis visible
- [ ] Realtime en -> transcript saved -> analysis visible
- [ ] Realtime multi remains experimental and not default
- [ ] Stop once does not leave analysis loading forever
- [ ] Duplicate stop does not trigger duplicate analysis spam

## 8. Error response smoke

- [ ] 401 response has canonical body
- [ ] 404/not-ready response has safe body
- [ ] `traceId` in body/header when applicable
- [ ] No stack trace exposed to FE

## 9. Logging and safety

- [ ] Logs include traceId/requestId/meetingId when relevant
- [ ] STT logs show requested/effective/deepgram language
- [ ] Analysis logs show trigger/saved/failed/skipped
- [ ] No API key/token/password in logs
- [ ] No full transcript/raw audio/raw provider payload in logs or report

## 10. Final decision

- [ ] Ready for demo
- [ ] Ready for submit
- [ ] Known non-blocking issues documented
