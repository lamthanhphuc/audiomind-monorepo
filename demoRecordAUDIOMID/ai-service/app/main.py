from fastapi import FastAPI, Depends, HTTPException, UploadFile, File
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from starlette.requests import Request
from starlette.responses import Response
from sqlalchemy.orm import Session
from sqlalchemy import text
from loguru import logger
import sys
from pathlib import Path
from uuid import uuid4

from app.database import (
    get_db,
    engine,
    Base,
    wait_for_database,
    ensure_bigint_meeting_id,
)
from app.schemas import (
    ProcessRequest,
    ProcessResponse,
    TranscriptResponse,
    AnalysisResponse,
    TranscriptSegment,
    ActionItem,
)
from app.config import get_settings, get_runtime_device
from app.ffmpeg_utils import ensure_ffmpeg_on_path
from app.job_status_store import (
    cleanup_expired_job_statuses,
    get_job_status,
    _get_client,
    load_job_statuses,
    set_job_status,
)
from app.tasks import process_meeting

try:
    from app.pipeline import ProcessingPipeline
except Exception as pipeline_import_error:
    ProcessingPipeline = None
    logger.warning(f"Pipeline modules unavailable: {repr(pipeline_import_error)}")

# Configure logging
logger.remove()
logger.add(sys.stderr, level="INFO", serialize=True)
logger.add("logs/app.log", rotation="500 MB", level="DEBUG", serialize=True)

# Initialize FastAPI app
app = FastAPI(
    title="AudioMind AI Service",
    description="AI-powered audio processing service for meeting transcription and analysis",
    version="1.0.0",
)

# Initialize pipeline
pipeline = ProcessingPipeline() if ProcessingPipeline is not None else None
settings = get_settings()


def _resolve_cors_origins() -> list[str]:
    raw = (settings.cors_allowed_origins or "").strip()
    if not raw:
        return ["http://localhost:5173"]

    values = [item.strip() for item in raw.split(",") if item.strip()]
    return values or ["http://localhost:5173"]


# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=_resolve_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-Trace-ID"],
)


@app.middleware("http")
async def inject_trace_headers(request: Request, call_next) -> Response:
    trace_id = (
        request.headers.get("x-trace-id")
        or request.headers.get("x-request-id")
        or uuid4().hex
    )
    request_id = request.headers.get("x-request-id") or trace_id
    request.state.trace_id = trace_id
    request.state.request_id = request_id

    response = await call_next(request)
    response.headers["x-trace-id"] = trace_id
    response.headers["x-request-id"] = request_id
    logger.bind(trace_id=trace_id, request_id=request_id).debug(
        f"request completed path={request.url.path} status={response.status_code}"
    )
    return response


def ensure_runtime_dirs() -> None:
    """Create writable runtime directories for mounted volumes in containers."""
    for runtime_dir in (
        Path("/app/models"),
        Path("/app/uploads"),
        Path("/app/storage"),
        Path("/app/storage/uploads"),
        Path("./storage"),
    ):
        runtime_dir.mkdir(parents=True, exist_ok=True)
        try:
            runtime_dir.chmod(0o775)
        except OSError as permission_error:
            logger.warning(
                f"Could not update permissions for {runtime_dir}: {permission_error}"
            )


def resolve_upload_dir() -> Path:
    """Pick the first writable upload directory shared across API and worker containers."""
    candidates = (Path("/app/uploads"), Path("/app/storage/uploads"), Path("./storage/uploads"))
    for upload_dir in candidates:
        try:
            upload_dir.mkdir(parents=True, exist_ok=True)
            probe_file = upload_dir / ".write_probe"
            with probe_file.open("wb") as probe:
                probe.write(b"ok")
            probe_file.unlink(missing_ok=True)
            return upload_dir
        except OSError as permission_error:
            logger.warning(f"Upload dir not writable ({upload_dir}): {permission_error}")

    raise RuntimeError("No writable upload directory is available")


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "AudioMind AI Service",
        "version": "1.0.0",
        "status": "running",
    }


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "whisper_model": settings.whisper_model,
        "device": get_runtime_device(),
        "lazy_load_models": settings.lazy_load_models,
        "enable_speaker_diarization": settings.enable_speaker_diarization,
    }


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/ready")
async def readiness_check():
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    _get_client().ping()
    if pipeline is None:
        raise HTTPException(status_code=503, detail="Pipeline dependencies unavailable")
    return {"status": "ready", "service": "ai-service"}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    trace_id = getattr(request.state, "trace_id", uuid4().hex)
    logger.exception(f"Unhandled exception trace_id={trace_id}: {repr(exc)}")
    return JSONResponse(
        status_code=500,
        content={
            "code": "INTERNAL_SERVER_ERROR",
            "message": "Unexpected server error",
            "trace_id": trace_id,
        },
    )


@app.post("/api/process", response_model=ProcessResponse)
async def process_audio(
    request: ProcessRequest,
    http_request: Request,
):
    """
    Queue audio file processing.

    Long-running model work executes in background task.
    """
    try:
        if pipeline is None:
            raise HTTPException(
                status_code=503,
                detail="Processing pipeline dependencies are not available",
            )

        trace_id = request.trace_id or getattr(http_request.state, "trace_id", None)
        logger.info(
            f"[traceId={trace_id}] [jobId={request.meeting_id}] received process request"
        )

        set_job_status(
            request.meeting_id,
            "QUEUED",
            file_id=request.file_id,
            trace_id=trace_id,
            progress=0,
            stage="uploading",
        )
        payload = request.model_dump()
        payload["trace_id"] = trace_id
        process_meeting.delay(payload)

        return ProcessResponse(
            meeting_id=request.meeting_id,
            status="queued",
            message="Processing job queued",
        )

    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.exception(
            f"Unexpected processing error request_id={request_id}: {repr(e)}"
        )
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error. request_id={request_id}",
        )


@app.post("/api/v1/process")
async def process_mock_v1(_: dict):
    """Deprecated endpoint retained for migration notice only."""
    raise HTTPException(
        status_code=410,
        detail="/api/v1/process is deprecated. Use /api/process with upload-audio flow.",
    )


@app.post("/api/upload-audio")
async def upload_audio(file: UploadFile = File(...)):
    try:
        uploads_dir = resolve_upload_dir()

        original_name = Path(file.filename or "audio.wav").name
        extension = (Path(original_name).suffix or ".wav").lower()
        allowed_extensions = {
            item.strip().lower()
            for item in settings.allowed_upload_extensions.split(",")
            if item.strip()
        }
        if extension not in allowed_extensions:
            raise HTTPException(
                status_code=415, detail="Unsupported audio file extension"
            )
        saved_name = f"{uuid4().hex}{extension}"
        saved_path = uploads_dir / saved_name

        total_bytes = 0
        chunk_size = 1024 * 1024

        with saved_path.open("wb") as output_file:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > settings.max_upload_size_bytes:
                    output_file.close()
                    saved_path.unlink(missing_ok=True)
                    raise HTTPException(status_code=413, detail="File too large")
                output_file.write(chunk)

        await file.close()

        return {
            "audio_path": str(saved_path),
            "original_filename": original_name,
        }
    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.exception(f"Upload audio error request_id={request_id}: {repr(e)}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error. request_id={request_id}",
        )


@app.get("/api/meeting/{meeting_id}/status")
async def get_processing_status(meeting_id: int):
    status = get_job_status(meeting_id)

    if status is None:
        raise HTTPException(status_code=404, detail="Meeting job status not found")

    return status


@app.get("/api/meeting/{meeting_id}/transcript", response_model=TranscriptResponse)
async def get_transcript(meeting_id: int, db: Session = Depends(get_db)):
    """
    Get transcript for a meeting

    Returns all transcript segments with speaker labels and timestamps
    """
    try:
        if pipeline is None:
            raise HTTPException(
                status_code=503,
                detail="Processing pipeline dependencies are not available",
            )

        logger.info(f"Fetching transcript for meeting {meeting_id}")

        transcripts = pipeline.get_transcript(meeting_id, db)

        if not transcripts:
            raise HTTPException(status_code=404, detail="Transcript not found")

        segments = [
            TranscriptSegment(
                speaker=t.speaker,
                start_time=t.start_time,
                end_time=t.end_time,
                text=t.text,
            )
            for t in transcripts
        ]

        return TranscriptResponse(meeting_id=meeting_id, transcripts=segments)

    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.error(f"Error fetching transcript request_id={request_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error. request_id={request_id}",
        )


@app.get("/api/meeting/{meeting_id}/analysis", response_model=AnalysisResponse)
async def get_analysis(meeting_id: int, db: Session = Depends(get_db)):
    """
    Get AI analysis for a meeting

    Returns summary, keywords, technical terms, and action items
    """
    try:
        if pipeline is None:
            raise HTTPException(
                status_code=503,
                detail="Processing pipeline dependencies are not available",
            )

        logger.info(f"Fetching analysis for meeting {meeting_id}")

        analysis = pipeline.get_analysis(meeting_id, db)

        if not analysis:
            raise HTTPException(status_code=404, detail="Analysis not found")

        action_items = [ActionItem(**item) for item in analysis.action_items]

        return AnalysisResponse(
            meeting_id=meeting_id,
            summary=analysis.summary,
            keywords=analysis.keywords,
            technical_terms=analysis.technical_terms,
            action_items=action_items,
            created_at=analysis.created_at,
        )

    except HTTPException:
        raise
    except Exception as e:
        request_id = uuid4().hex
        logger.error(f"Error fetching analysis request_id={request_id}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error. request_id={request_id}",
        )


@app.on_event("startup")
async def startup_event():
    """Startup event"""
    ensure_runtime_dirs()
    load_job_statuses(recover_interrupted=True)
    cleanup_expired_job_statuses()
    cleanup_expired_job_statuses()

    try:
        wait_for_database()
    except Exception as e:
        logger.warning(f"Database connectivity check skipped: {repr(e)}")

    try:
        ensure_bigint_meeting_id()
    except Exception as e:
        logger.warning(f"Database migration step skipped: {repr(e)}")

    try:
        Base.metadata.create_all(bind=engine)
    except Exception as e:
        logger.warning(f"Database schema initialization failed: {repr(e)}")

    try:
        ensure_ffmpeg_on_path(log=True)
    except Exception as e:
        # Keep service up; requests that need ffmpeg will return a clear error.
        logger.warning(f"FFmpeg bootstrap warning: {repr(e)}")

    logger.info("=" * 50)
    logger.info("AudioMind AI Service Starting...")
    logger.info(f"Whisper Model: {settings.whisper_model}")
    logger.info(f"Device: {get_runtime_device()}")
    logger.info("=" * 50)


@app.on_event("shutdown")
async def shutdown_event():
    """Shutdown event"""
    cleanup_expired_job_statuses()
    logger.info("AudioMind AI Service Shutting Down...")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=True)
