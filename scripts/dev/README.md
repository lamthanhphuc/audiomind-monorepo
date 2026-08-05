# Dev utilities (Python)

Ad-hoc scripts for local smoke checks and STT debugging. Run from repo root.

| Script | Purpose | Prerequisites |
|--------|---------|---------------|
| `smoke_test.py` | Register/login user-api and exercise basic API flow | user-api `:8083`, meeting/processing as needed |
| `diagnose_stt.py` | STT pipeline diagnostics | ai-service, redis, STT adapters |
| `create-admin.ps1` | Bootstrap/promote local admin account | user-api `:8083`, PostgreSQL access via `psql` or Docker Compose |
| `test_adapter.py` | Exercise STT adapter directly | ai-service env |
| `test_stream_direct.py` | Direct streaming STT test | ai-service websocket/stream |
| `test_stt_pipeline.py` | End-to-end STT pipeline check | full stack or partial services |

## Examples

```bash
python scripts/dev/smoke_test.py
python scripts/dev/diagnose_stt.py
powershell -ExecutionPolicy Bypass -File scripts/dev/create-admin.ps1
```

Default admin credentials:

- username: `admin`
- email: `admin@audiomind.local`
- password: `Admin@123456`

If PostgreSQL is only reachable inside Docker Compose, add `-UseDockerCompose`.
If the user already exists and only needs admin promotion, add `-SkipRegister`.

## E2E invite deep-link env (Playwright)

Optional credential-flow test in `FE-Audiomind/tests/e2e/share.spec.ts`:

- `PLAYWRIGHT_REAL_BACKEND=1`
- `E2E_INVITE_MEETING_ID` — meeting id with share access
- `E2E_USERNAME_2` / `E2E_PASSWORD_2` — invitee account (pending share accepted)

Banner-only test needs web app only (`/register?openMeeting=15`).
