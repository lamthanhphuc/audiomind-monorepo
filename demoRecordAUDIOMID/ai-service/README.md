# AudioMind AI Service

Python FastAPI service for cloud-first transcription and AI analysis.

## Features

- 🎤 Speech-to-Text (Deepgram cloud STT)
- 👥 Speaker Diarization (Deepgram native diarization by default)
- 🤖 AI Meeting Analysis (Gemini by default)
- ⚡ Realtime STT adapter (Deepgram)
- 📊 Structured Meeting Notes
- 🧪 Optional legacy/offline Whisper stack via explicit opt-in build

## Architecture

```
AI Service (Port 8000)
│
├── Audio Processing
│   └── Audio utilities
│
├── Speech Recognition
│   ├── Deepgram batch STT
│   └── Whisper (legacy/offline opt-in only)
│
├── Speaker Diarization
│   ├── Deepgram native diarization
│   └── pyannote.audio (legacy/offline opt-in only)
│
├── AI Analysis
│   └── Gemini (cloud-first default)
│
├── Realtime Streaming
│   ├── gRPC StreamAudio
│   └── Deepgram STT adapter
│
└── Database
    └── PostgreSQL
```

## Installation

1. Create virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # Linux/Mac
# or
venv\Scripts\activate  # Windows
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

For legacy/offline Whisper and pyannote support, install the optional stack:

```bash
pip install -c constraints-offline.txt -r requirements-offline.txt
```

3. Setup environment variables:
```bash
cp .env.example .env
# Edit .env with your API keys
```

4. Run database migrations:
```bash
alembic upgrade head
```

5. Start server:
```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## API Endpoints

- `POST /api/process` - Process audio file
- `GET /api/meeting/{meeting_id}/transcript` - Get transcript
- `GET /api/meeting/{meeting_id}/analysis` - Get AI analysis
- `GET /health` - Health check

## Requirements

- Python 3.9+
- PostgreSQL 14+
- FFmpeg

`requirements.txt` is the cloud-first runtime set. PyTorch, Whisper, pyannote,
and Silero VAD live in `requirements-offline.txt` and are not installed by the
default Docker image.

## Docker Build Modes

Default `ai-api` and `celery-worker` Docker builds are cloud-first:

```bash
docker compose -f infra/docker-compose.dev.yml build ai-api celery-worker
```

This default does not install Torch/CUDA, OpenAI Whisper, pyannote, or Silero
VAD. Deepgram STT and Gemini analysis remain the default runtime path.

Legacy/offline local Whisper support is opt-in:

```bash
docker compose -f infra/docker-compose.dev.yml build \
  --build-arg INSTALL_OFFLINE_STT=true ai-api celery-worker
```

If `STT_PROVIDER=local_whisper` or `LOCAL_WHISPER_ENABLED=true` is enabled on a
cloud-first image, the service raises a clear error asking to rebuild with
`INSTALL_OFFLINE_STT=true`.

## Configuration

See `.env.example` for all configuration options.

### Required/Important Environment Variables

- `DATABASE_URL`
- `DEEPGRAM_API_KEY` (required for Deepgram batch and realtime STT)
- `DEEPGRAM_MODEL` (optional, default defined in app config)
- `DEEPGRAM_BASE_URL` (optional, default Deepgram listen endpoint)
- `DEEPGRAM_TIMEOUT_SECONDS` (optional timeout tuning)
- `GEMINI_API_KEY` (required when `ANALYSIS_PROVIDER=gemini`)

### Runtime Modes

- **Cloud-first default**: `STT_PROVIDER=deepgram`,
  `ANALYSIS_PROVIDER=gemini`, `LOCAL_WHISPER_ENABLED=false`,
  `ALLOW_LEGACY_LOCAL_STT=false`, and `OLLAMA_ENABLED=false`.
- **Legacy/offline opt-in**: build with `INSTALL_OFFLINE_STT=true`, then enable
  `ALLOW_LEGACY_LOCAL_STT=true` plus `STT_PROVIDER=local_whisper` or
  `LOCAL_WHISPER_ENABLED=true`.

### Diarization Toggle and Fallback

- Config key: `enable_speaker_diarization`.
- Runtime behavior:
    - Default compose enables Deepgram native diarization with `DEEPGRAM_DIARIZE=true`.
    - Local pyannote diarization is legacy/offline only and requires the optional stack.
- If pyannote model/token is unavailable in a legacy/offline run, pipeline auto-disables diarization and logs warning.

### Anti-loop STT Settings

Legacy Whisper transcription uses anti-loop defaults for long audio processing:

- `condition_on_previous_text = false`
- `whisper_no_speech_threshold = 0.7`
- `whisper_logprob_threshold = -0.8`
- chunked decoding for long audio (`whisper_cpu_chunk_seconds`, `whisper_gpu_chunk_seconds`)

### Debug Transcript Repetition

When output repeats short text (e.g. "Chuyên là..."):

1. Confirm runtime snapshot in `ai-service/logs/baseline_<meeting_id>.json`.
2. Check transcript rows around issue timestamp:
     - `SELECT speaker, start_time, end_time, text FROM transcripts WHERE meeting_id=<id> ORDER BY start_time;`
3. Increase strictness if needed:
     - raise `whisper_no_speech_threshold` (e.g. `0.75`)
     - raise `whisper_logprob_threshold` toward `-0.6`
     - reduce CPU chunk size (e.g. `20-30s`)
4. Reprocess and compare before/after at same timestamp window.

## Realtime Streaming

The service includes gRPC streaming support for realtime transcription and keyword flows.

- gRPC service definition is in `packages/contracts/ai-stream.proto`.
- Bidirectional streaming RPC: `StreamAudio(stream StreamEnvelope) returns (stream StreamEnvelope)`.
- Realtime event payloads are defined in `packages/contracts/realtime-events.proto`.

Typical flow:
1. Client/gateway opens `StreamAudio` stream.
2. Client sends `audio_chunk` envelopes incrementally.
3. Service emits `transcript_partial` and related events as they are available.
4. Upstream gateway broadcasts to frontend WebSocket clients.

For local integration testing, keep `DEEPGRAM_API_KEY` configured before starting the gRPC streaming path.

## Models

- **Cloud STT**: Deepgram adapter (configurable model/base URL)
- **Cloud analysis**: Gemini
- **Legacy Whisper**: base/large-v3 depending on `WHISPER_MODEL`
- **Legacy Speaker Diarization**: pyannote/speaker-diarization-3.1
- **Legacy VAD**: silero-vad
