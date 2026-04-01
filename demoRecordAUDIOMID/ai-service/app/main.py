from fastapi import FastAPI, Depends, HTTPException, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from loguru import logger
import sys
from pathlib import Path
from uuid import uuid4

from app.database import get_db, engine, Base, wait_for_database, ensure_bigint_meeting_id
from app.pipeline import ProcessingPipeline
from app.schemas import (
    ProcessRequest, 
    ProcessResponse, 
    TranscriptResponse, 
    AnalysisResponse,
    TranscriptSegment,
    ActionItem
)
from app.config import get_settings, get_runtime_device
from app.ffmpeg_utils import ensure_ffmpeg_on_path

# Configure logging
logger.remove()
logger.add(sys.stderr, level="INFO")
logger.add("logs/app.log", rotation="500 MB", level="DEBUG")

# Initialize FastAPI app
app = FastAPI(
    title="AudioMind AI Service",
    description="AI-powered audio processing service for meeting transcription and analysis",
    version="1.0.0"
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize pipeline
pipeline = ProcessingPipeline()
settings = get_settings()


@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "AudioMind AI Service",
        "version": "1.0.0",
        "status": "running"
    }


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "whisper_model": settings.whisper_model,
        "device": get_runtime_device(),
        "lazy_load_models": settings.lazy_load_models,
        "enable_speaker_diarization": settings.enable_speaker_diarization
    }


@app.post("/api/process", response_model=ProcessResponse)
async def process_audio(
    request: ProcessRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db)
):
    """
    Process audio file through complete pipeline
    
    - Loads audio from path
    - Performs speech recognition
    - Performs speaker diarization
    - Performs AI analysis
    - Saves results to database
    """
    try:
        logger.info(
            f"Received process request for meeting {request.meeting_id}, audio: {request.audio_path}"
        )

        meeting_id = request.meeting_id
        
        # Process in background (for long audio files)
        # For prototype, we'll process synchronously
        result = pipeline.process_meeting(
            audio_path=request.audio_path,
            meeting_id=meeting_id,
            db=db,
            topic=request.topic,
            glossary_terms=request.glossary_terms,
            language=request.language,
        )
        
        return ProcessResponse(
            meeting_id=meeting_id,
            status="completed",
            message="Processing completed successfully"
        )
        
    except Exception as e:
        logger.exception(f"Processing error: {repr(e)}")
        raise HTTPException(status_code=500, detail=repr(e))


@app.post("/api/upload-audio")
async def upload_audio(file: UploadFile = File(...)):
    try:
        uploads_dir = Path("/app/uploads")
        uploads_dir.mkdir(parents=True, exist_ok=True)

        original_name = Path(file.filename or "audio.wav").name
        extension = Path(original_name).suffix or ".wav"
        saved_name = f"{uuid4().hex}{extension}"
        saved_path = uploads_dir / saved_name

        file_bytes = await file.read()
        saved_path.write_bytes(file_bytes)

        return {
            "audio_path": str(saved_path),
            "original_filename": original_name,
        }
    except Exception as e:
        logger.exception(f"Upload audio error: {repr(e)}")
        raise HTTPException(status_code=500, detail=repr(e))


@app.get("/api/meeting/{meeting_id}/transcript", response_model=TranscriptResponse)
async def get_transcript(meeting_id: int, db: Session = Depends(get_db)):
    """
    Get transcript for a meeting
    
    Returns all transcript segments with speaker labels and timestamps
    """
    try:
        logger.info(f"Fetching transcript for meeting {meeting_id}")
        
        transcripts = pipeline.get_transcript(meeting_id, db)
        
        if not transcripts:
            raise HTTPException(status_code=404, detail="Transcript not found")
        
        segments = [
            TranscriptSegment(
                speaker=t.speaker,
                start_time=t.start_time,
                end_time=t.end_time,
                text=t.text
            )
            for t in transcripts
        ]
        
        return TranscriptResponse(
            meeting_id=meeting_id,
            transcripts=segments
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching transcript: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/meeting/{meeting_id}/analysis", response_model=AnalysisResponse)
async def get_analysis(meeting_id: int, db: Session = Depends(get_db)):
    """
    Get AI analysis for a meeting
    
    Returns summary, keywords, technical terms, and action items
    """
    try:
        logger.info(f"Fetching analysis for meeting {meeting_id}")
        
        analysis = pipeline.get_analysis(meeting_id, db)
        
        if not analysis:
            raise HTTPException(status_code=404, detail="Analysis not found")
        
        action_items = [
            ActionItem(**item) for item in analysis.action_items
        ]
        
        return AnalysisResponse(
            meeting_id=meeting_id,
            summary=analysis.summary,
            keywords=analysis.keywords,
            technical_terms=analysis.technical_terms,
            action_items=action_items,
            created_at=analysis.created_at
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching analysis: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.on_event("startup")
async def startup_event():
    """Startup event"""
    wait_for_database()
    ensure_bigint_meeting_id()
    Base.metadata.create_all(bind=engine)

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
    logger.info("AudioMind AI Service Shutting Down...")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=True
    )
