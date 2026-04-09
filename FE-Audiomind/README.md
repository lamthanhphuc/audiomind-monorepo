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

## Notes

- Login is mock/local only.
- Upload audio, then run processing to fetch AI summary.
- In production builds, missing required API base variables cause startup failure.
