# AudioMind AI Service

Python FastAPI service for audio processing, speech recognition, speaker diarization, and AI analysis.

## Features

- 🎤 Speech-to-Text (Whisper)
- 👥 Speaker Diarization (pyannote.audio)
- 🔊 Voice Activity Detection (Silero VAD)
- 🤖 AI Meeting Analysis (Ollama)
- ⚡ Realtime STT adapter (Deepgram)
- 📊 Structured Meeting Notes

## Architecture

```
AI Service (Port 8000)
│
├── Audio Processing
│   ├── VAD
│   └── Audio Segmentation
│
├── Speech Recognition
│   └── Whisper
│
├── Speaker Diarization
│   └── pyannote.audio
│
├── AI Analysis
│   └── Ollama (local/runtime configurable)
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
- CUDA (optional, for GPU acceleration)
- FFmpeg

## Configuration

See `.env.example` for all configuration options.

### Required/Important Environment Variables

- `DATABASE_URL`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `DEEPGRAM_API_KEY` (required for Deepgram realtime STT adapter)
- `DEEPGRAM_MODEL` (optional, default defined in app config)
- `DEEPGRAM_BASE_URL` (optional, default Deepgram listen endpoint)
- `DEEPGRAM_TIMEOUT_SECONDS` (optional timeout tuning)

### Runtime Modes (CPU vs GPU)

- **GPU mode** (`torch.cuda.is_available() == true`):
    - Speaker diarization is enabled by default.
    - Whisper long-audio chunk size defaults to `60s`.
- **CPU mode**:
    - Speaker diarization follows `ENABLE_SPEAKER_DIARIZATION` config toggle.
    - Whisper long-audio chunk size defaults to `30s`.

### Diarization Toggle and Fallback

- Config key: `enable_speaker_diarization`.
- Runtime behavior:
    - GPU: force enable diarization by default.
    - CPU: enable only when config is `true`.
- If pyannote model/token is unavailable, pipeline auto-disables diarization and logs warning.

### Anti-loop STT Settings

Whisper transcription uses anti-loop defaults for long audio processing:

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

- **Whisper**: large-v3
- **Speaker Diarization**: pyannote/speaker-diarization-3.1
- **VAD**: silero-vad
- **LLM**: Ollama runtime models (for example `qwen2.5:3b-instruct`)
- **Realtime STT**: Deepgram adapter (configurable model/base URL)
