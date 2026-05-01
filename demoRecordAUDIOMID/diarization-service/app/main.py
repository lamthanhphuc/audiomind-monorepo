from pathlib import Path
import logging
from contextlib import asynccontextmanager

import librosa
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel

MODELS_DIR = Path("/app/models")
UPLOADS_DIR = Path("/app/uploads")
logger = logging.getLogger(__name__)


class DiarizeRequest(BaseModel):
    audio_path: str


class DiarizationRuntime:
    def ensure_dirs(self) -> None:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        for target in (MODELS_DIR, UPLOADS_DIR):
            try:
                target.chmod(0o775)
            except OSError as permission_error:
                logger.warning("Could not update permissions for %s: %s", target, permission_error)

    def diarize_lightweight(self, audio_path: str) -> list[dict]:
        y, sr = librosa.load(audio_path, sr=None, mono=True)

        # Lightweight local diarization: split by silence and alternate speaker labels.
        intervals = librosa.effects.split(y, top_db=28)
        if len(intervals) == 0:
            duration = float(librosa.get_duration(y=y, sr=sr))
            return [
                {
                    "speaker": "SPEAKER_1",
                    "start": 0.0,
                    "end": round(duration, 2),
                }
            ]

        segments = []
        speaker_index = 1
        for interval in intervals:
            start = round(float(interval[0] / sr), 2)
            end = round(float(interval[1] / sr), 2)
            if end <= start:
                continue

            segments.append(
                {
                    "speaker": f"SPEAKER_{speaker_index}",
                    "start": start,
                    "end": end,
                }
            )
            speaker_index = 2 if speaker_index == 1 else 1

        return segments

    def diarize_incremental(
        self,
        audio_path: str,
        window_seconds: float = 15.0,
        hop_seconds: float = 5.0,
    ) -> list[dict]:
        y, sr = librosa.load(audio_path, sr=None, mono=True)
        duration = float(librosa.get_duration(y=y, sr=sr))

        if len(y) == 0:
            return []

        window_samples = max(int(window_seconds * sr), 1)
        hop_samples = max(int(hop_seconds * sr), 1)
        segments: list[dict] = []
        last_emitted_end = 0.0
        speaker_index = 1

        for window_start in range(0, len(y), hop_samples):
            window_end = min(window_start + window_samples, len(y))
            window_audio = y[window_start:window_end]
            if len(window_audio) == 0:
                continue

            intervals = librosa.effects.split(window_audio, top_db=28)
            if len(intervals) == 0:
                continue

            for interval in intervals:
                start = round(float((window_start + interval[0]) / sr), 2)
                end = round(float((window_start + interval[1]) / sr), 2)
                if end <= start:
                    continue

                if end <= last_emitted_end + 0.05:
                    continue

                if start < last_emitted_end:
                    start = round(last_emitted_end, 2)

                if end <= start:
                    continue

                segments.append(
                    {
                        "speaker": f"SPEAKER_{speaker_index}",
                        "start": start,
                        "end": end,
                    }
                )
                speaker_index = 2 if speaker_index == 1 else 1
                last_emitted_end = end

        if not segments:
            return [
                {
                    "speaker": "SPEAKER_1",
                    "start": 0.0,
                    "end": round(duration, 2),
                }
            ]

        return segments


runtime = DiarizationRuntime()


@asynccontextmanager
async def lifespan(_: FastAPI):
    runtime.ensure_dirs()
    yield


app = FastAPI(title="diarization-service", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "mode": "incremental-window",
    }


@app.get("/metrics")
def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/diarize")
def diarize(payload: DiarizeRequest) -> dict:
    runtime.ensure_dirs()

    audio_file = Path(payload.audio_path)
    if not audio_file.exists():
        raise HTTPException(status_code=404, detail=f"Audio not found: {payload.audio_path}")

    segments = runtime.diarize_incremental(str(audio_file))
    return {"segments": segments, "mode": "incremental-window"}
