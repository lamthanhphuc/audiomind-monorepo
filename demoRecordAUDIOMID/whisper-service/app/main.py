from pathlib import Path
import logging
from contextlib import asynccontextmanager

import torch
import whisper
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel

MODELS_DIR = Path("/app/models")
UPLOADS_DIR = Path("/app/uploads")
logger = logging.getLogger(__name__)


class TranscribeRequest(BaseModel):
    audio_path: str
    language: str | None = None


class WhisperRuntime:
    def __init__(self) -> None:
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = None

    def ensure_ready(self) -> None:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        for target in (MODELS_DIR, UPLOADS_DIR):
            try:
                target.chmod(0o775)
            except OSError as permission_error:
                logger.warning("Could not update permissions for %s: %s", target, permission_error)

        if self.model is None:
            self.model = whisper.load_model(
                "base",
                device=self.device,
                download_root="/app/models",
            )


runtime = WhisperRuntime()


@asynccontextmanager
async def lifespan(_: FastAPI):
    runtime.ensure_ready()
    yield


app = FastAPI(title="whisper-service", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "device": runtime.device, "model": "base"}


@app.get("/metrics")
def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/transcribe")
def transcribe(payload: TranscribeRequest) -> dict:
    runtime.ensure_ready()

    audio_file = Path(payload.audio_path)
    if not audio_file.exists():
        raise HTTPException(status_code=404, detail=f"Audio not found: {payload.audio_path}")

    result = runtime.model.transcribe(
        str(audio_file),
        language=payload.language,
        task="transcribe",
        word_timestamps=False,
        verbose=False,
    )

    segments = [
        {
            "start": float(segment.get("start", 0.0)),
            "end": float(segment.get("end", 0.0)),
            "text": str(segment.get("text", "")).strip(),
        }
        for segment in result.get("segments", [])
    ]

    return {
        "text": (result.get("text", "") or "").strip(),
        "segments": segments,
        "language": result.get("language", payload.language or "unknown"),
        "device": runtime.device,
    }
