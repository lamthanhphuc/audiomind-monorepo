# AudioMind Frontend

React + Vite frontend for the AudioMind demo.

## Scripts

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

## Environment

Create or update `.env` (or `.env.local`):

- `VITE_MEETING_API_BASE_URL` (primary) or `VITE_MEETING_SERVICE_URL` (legacy)
- `VITE_PROCESSING_API_BASE_URL` (primary) or `VITE_PROCESSING_SERVICE_URL` (legacy)
- `VITE_API_BASE` (optional umbrella base URL)
- `VITE_AI_SERVICE_URL` or `VITE_API_CPU_BASE` for direct AI endpoint wiring
- `VITE_REALTIME_WS_ENABLED` (`true` to enable realtime WebSocket flow; `false` for polling fallback)
- `VITE_REALTIME_WS_BASE_URL` (optional explicit WebSocket base URL)

## Notes

- Login is mock/local only.
- Upload audio, then run processing to fetch AI summary.
- Realtime transcript/keyword streaming is controlled by feature flag and can safely fall back to polling.
- In production builds, missing required API base variables cause startup failure.

## Realtime Feature

Enable realtime mode in local/staging:

```bash
VITE_REALTIME_WS_ENABLED=true
```

Disable realtime mode (force polling fallback):

```bash
VITE_REALTIME_WS_ENABLED=false
```

Optional explicit WS base URL example:

```bash
VITE_REALTIME_WS_BASE_URL=ws://localhost:8082/ws
```

## E2E Prerequisites (Local/CI)

Before running Playwright against real backend, ensure an E2E account exists in `user-service`.

PowerShell (Windows):

```powershell
$env:E2E_USERNAME='e2e_test_user'
$env:E2E_PASSWORD='Test@123456'
pwsh ../scripts/setup-e2e-account.ps1
```

Then run E2E:

```powershell
$env:PLAYWRIGHT_REAL_BACKEND='1'
npm run test:e2e:ci
```

Optional (force realtime flag during E2E run):

```powershell
$env:PLAYWRIGHT_REAL_BACKEND='1'
$env:VITE_REALTIME_WS_ENABLED='true'
npm run test:e2e:ci
```

Notes:
- `setup-e2e-account.ps1` defaults to `http://localhost:8083` for `user-service`.
- Override user-service base URL with `E2E_USER_SERVICE_BASE_URL` if your environment differs.
- The script is idempotent: if the account already exists, it still exits successfully.
- `PLAYWRIGHT_REAL_BACKEND=1` is required for real-backend E2E mode.

For database inspection options, see [docs/database-access.md](../docs/database-access.md).
