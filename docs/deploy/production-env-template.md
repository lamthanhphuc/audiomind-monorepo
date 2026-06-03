# Production Env Template

Use [infra/.env.production.example](../../infra/.env.production.example) as the
production VPS template.

Copy it to `infra/.env` on the VPS only:

```bash
cp infra/.env.production.example infra/.env
```

Replace these placeholder values before rendering Compose config:

- `app.example.com`, `meeting.example.com`, `processing.example.com`, and
  `user.example.com`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`

Production public routing is subdomain-based:

- `https://app.<domain>` -> `web`
- `https://meeting.<domain>` -> `meeting-api`
- `https://processing.<domain>` -> `processing-api`
- `https://user.<domain>` -> `user-api`

Keep these values loopback-bound so Caddy is the only public entry point:

```dotenv
WEB_BIND_ADDRESS=127.0.0.1
MEETING_API_BIND_ADDRESS=127.0.0.1
PROCESSING_API_BIND_ADDRESS=127.0.0.1
USER_API_BIND_ADDRESS=127.0.0.1
```

Production CORS should allow only the frontend origin:

```dotenv
CORS_ALLOWED_ORIGINS=https://app.<domain>
```

Frontend build URLs should use the public subdomains:

```dotenv
VITE_MEETING_API_BASE_URL=https://meeting.<domain>
VITE_PROCESSING_API_BASE_URL=https://processing.<domain>
VITE_USER_API_BASE_URL=https://user.<domain>
VITE_API_BASE=https://processing.<domain>
VITE_REALTIME_WS_BASE_URL=wss://processing.<domain>/ws/meetings
```

`VITE_API_CPU_BASE`, `VITE_API_GPU_BASE`, and `VITE_AI_SERVICE_URL` are required
by the current frontend build. The production VPS target keeps `ai-api` private,
so leave them pointed at the unrouted placeholders from the template unless a
separate protected AI route is intentionally introduced.

Do not edit or commit any real `.env` file.
