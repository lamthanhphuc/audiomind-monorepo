# Production Env Template

Use [infra/.env.production.example](../../infra/.env.production.example) as the
production VPS template.

Copy it to `infra/.env` on the production server only:

```bash
cp infra/.env.production.example infra/.env
```

The current Vietnix deployment uses this subdomain strategy. `DOMAIN_ROOT` is
kept for human/script convenience, while runtime/public URL values should be
explicit literals in `infra/.env`.

- `DOMAIN_ROOT=audiomind.pro.vn`
- `APP_DOMAIN=app.audiomind.pro.vn`
- `MEETING_DOMAIN=meeting.audiomind.pro.vn`
- `PROCESSING_DOMAIN=processing.audiomind.pro.vn`
- `USER_DOMAIN=user.audiomind.pro.vn`

Replace these placeholder secret values before rendering Compose config:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`

Production public routing is subdomain-based:

- `https://app.<domain>` -> `web`
- `https://meeting.<domain>` -> `meeting-api`
- `https://processing.<domain>` -> `processing-api`
- `https://user.<domain>` -> `user-api`

For Vietnix and `audiomind.pro.vn`, that means:

- `https://app.audiomind.pro.vn` -> `web`
- `https://meeting.audiomind.pro.vn` -> `meeting-api`
- `https://processing.audiomind.pro.vn` -> `processing-api`
- `https://user.audiomind.pro.vn` -> `user-api`

Keep these values loopback-bound so Caddy is the only public entry point:

```dotenv
WEB_BIND_ADDRESS=127.0.0.1
MEETING_API_BIND_ADDRESS=127.0.0.1
PROCESSING_API_BIND_ADDRESS=127.0.0.1
USER_API_BIND_ADDRESS=127.0.0.1
```

Production CORS should allow only the frontend origin:

```dotenv
CORS_ALLOWED_ORIGINS=https://app.audiomind.pro.vn
```

Frontend build URLs should use the public subdomains:

```dotenv
VITE_MEETING_API_BASE_URL=https://meeting.audiomind.pro.vn
VITE_PROCESSING_API_BASE_URL=https://processing.audiomind.pro.vn
VITE_USER_API_BASE_URL=https://user.audiomind.pro.vn
VITE_API_BASE=https://processing.audiomind.pro.vn
VITE_REALTIME_WS_BASE_URL=wss://processing.audiomind.pro.vn/ws/meetings
```

`VITE_API_CPU_BASE`, `VITE_API_GPU_BASE`, and `VITE_AI_SERVICE_URL` are required
by the current frontend build. The production VPS target keeps `ai-api` private,
so leave them pointed at the unrouted placeholders from the template unless a
separate protected AI route is intentionally introduced.

Do not create or edit the real production `infra/.env` in a developer checkout
unless that machine is the deployment host. Never commit any real `.env` file.
