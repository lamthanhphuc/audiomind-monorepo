import os
import logging
from pathlib import Path
from uuid import uuid4

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

UPLOADS_DIR = Path("/app/uploads")
WHISPER_URL = os.getenv("WHISPER_SERVICE_URL", "http://whisper-service:8011")
DIARIZATION_URL = os.getenv(
    "DIARIZATION_SERVICE_URL", "http://diarization-service:8012"
)
OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://ollama-service:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:3b")

app = FastAPI(title="processing-service", version="1.0.0")
logger = logging.getLogger(__name__)


def ensure_runtime_dirs() -> None:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        UPLOADS_DIR.chmod(0o775)
    except OSError as permission_error:
        logger.warning("Could not update permissions for %s: %s", UPLOADS_DIR, permission_error)


def validate_runtime_configuration() -> None:
    environment = os.getenv("APP_ENV", "development").lower()
    if environment != "production":
        return

    required = ["WHISPER_SERVICE_URL", "DIARIZATION_SERVICE_URL", "OLLAMA_BASE_URL"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError(
            "Missing required production environment variables: " + ", ".join(missing)
        )


def overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def merge_transcript_with_speakers(
    transcript_segments: list[dict], speaker_segments: list[dict]
) -> list[dict]:
    if not speaker_segments:
        return [
            {
                "speaker": "SPEAKER_1",
                "start": seg.get("start", 0.0),
                "end": seg.get("end", 0.0),
                "text": seg.get("text", "").strip(),
            }
            for seg in transcript_segments
        ]

    merged = []
    for seg in transcript_segments:
        seg_start = float(seg.get("start", 0.0))
        seg_end = float(seg.get("end", seg_start))
        best_speaker = "SPEAKER_1"
        best_overlap = 0.0

        for speaker_seg in speaker_segments:
            score = overlap(
                seg_start,
                seg_end,
                float(speaker_seg.get("start", 0.0)),
                float(speaker_seg.get("end", 0.0)),
            )
            if score > best_overlap:
                best_overlap = score
                best_speaker = str(speaker_seg.get("speaker", "SPEAKER_1"))

        merged.append(
            {
                "speaker": best_speaker,
                "start": seg_start,
                "end": seg_end,
                "text": str(seg.get("text", "")).strip(),
            }
        )

    return merged


def conversation_lines(merged_segments: list[dict]) -> list[str]:
    speaker_map: dict[str, str] = {}
    speaker_count = 1
    lines = []

    for seg in merged_segments:
        raw_speaker = str(seg.get("speaker", "SPEAKER_1"))
        if raw_speaker not in speaker_map:
            speaker_map[raw_speaker] = f"Speaker {speaker_count}"
            speaker_count += 1
        label = speaker_map[raw_speaker]
        text = str(seg.get("text", "")).strip()
        if text:
            lines.append(f"{label}: {text}")

    return lines


async def summarize_with_ollama(conversation_text: str) -> str:
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "prompt": f"Summarize the following conversation:\n\n{conversation_text}",
    }
    async with httpx.AsyncClient(timeout=300) as client:
        response = await client.post(f"{OLLAMA_URL}/api/generate", json=payload)
        response.raise_for_status()
        body = response.json()
        return (body.get("response", "") or "").strip()


@app.on_event("startup")
def startup_event() -> None:
    ensure_runtime_dirs()
    validate_runtime_configuration()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "ollama_model": OLLAMA_MODEL}


@app.get("/metrics")
def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/ready")
async def ready() -> dict:
    async with httpx.AsyncClient(timeout=10) as client:
        whisper = await client.get(f"{WHISPER_URL}/health")
        whisper.raise_for_status()
        diarization = await client.get(f"{DIARIZATION_URL}/health")
        diarization.raise_for_status()
        ollama = await client.get(f"{OLLAMA_URL}/api/tags")
        ollama.raise_for_status()
    return {"status": "ready", "service": "ai-processing-service"}


@app.post("/api/v1/process")
async def process_audio(
    file: UploadFile = File(...), language: str | None = None
) -> dict:
    ensure_runtime_dirs()

    file_ext = Path(file.filename or "audio.wav").suffix or ".wav"
    audio_path = UPLOADS_DIR / f"{uuid4().hex}{file_ext}"
    audio_path.write_bytes(await file.read())

    try:
        async with httpx.AsyncClient(timeout=600) as client:
            whisper_res = await client.post(
                f"{WHISPER_URL}/transcribe",
                json={"audio_path": str(audio_path), "language": language},
            )
            whisper_res.raise_for_status()
            transcript_payload = whisper_res.json()

            diarization_res = await client.post(
                f"{DIARIZATION_URL}/diarize",
                json={"audio_path": str(audio_path)},
            )
            diarization_res.raise_for_status()
            diarization_payload = diarization_res.json()

        merged = merge_transcript_with_speakers(
            transcript_payload.get("segments", []),
            diarization_payload.get("segments", []),
        )
        lines = conversation_lines(merged)
        conversation = "\n".join(lines)
        summary = await summarize_with_ollama(conversation)

        return {
            "audio_path": str(audio_path),
            "transcript_text": transcript_payload.get("text", ""),
            "speaker_segments": diarization_payload.get("segments", []),
            "merged_segments": merged,
            "conversation": lines,
            "summary": summary,
        }
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"Upstream service error: {exc}"
        ) from exc


@app.exception_handler(Exception)
async def global_exception_handler(_, exc: Exception):
    trace_id = uuid4().hex
    # Keep full details in logs while returning a safe client-facing message.
    logger.error("Unhandled exception trace_id=%s: %r", trace_id, exc)
    return JSONResponse(
        status_code=500,
        content={
            "code": "INTERNAL_SERVER_ERROR",
            "message": "Unexpected server error",
            "trace_id": trace_id,
        },
    )
