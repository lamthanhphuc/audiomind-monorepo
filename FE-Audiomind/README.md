# AudioMind Frontend

React + Vite frontend for the AudioMind demo.

## Scripts

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run preview`

## Environment

Create or update `.env`:

- `VITE_MEETING_SERVICE_URL` (default `http://localhost:8081`)
- `VITE_PROCESSING_SERVICE_URL` (default `http://localhost:8082`)
- `VITE_AI_SERVICE_URL` (default `http://localhost:8000`)

## Notes

- Login is mock/local only.
- Upload audio, then run processing to fetch AI summary.
