from loguru import logger

from app.celery_app import celery_app
from app.database import SessionLocal
from app.job_status_store import set_job_status

try:
    from app.pipeline import ProcessingPipeline
except Exception as pipeline_import_error:
    ProcessingPipeline = None
    logger.warning(f"Pipeline modules unavailable in worker: {repr(pipeline_import_error)}")

pipeline = ProcessingPipeline() if ProcessingPipeline is not None else None


@celery_app.task(name="app.tasks.process_meeting")
def process_meeting(payload: dict) -> None:
    meeting_id = int(payload["meeting_id"])
    trace_id = payload.get("trace_id")
    file_id = payload.get("file_id")
    db = SessionLocal()

    result_data = {
        "transcripts": [],
    }

    try:
        if pipeline is None:
            raise RuntimeError("Processing pipeline dependencies are not available")

        logger.info(f"[traceId={trace_id}] [jobId={meeting_id}] update RUNNING")
        set_job_status(meeting_id, "RUNNING", file_id=file_id, trace_id=trace_id)

        pipeline.process_meeting(
            audio_path=payload["audio_path"],
            meeting_id=meeting_id,
            db=db,
            topic=payload.get("topic"),
            glossary_terms=payload.get("glossary_terms"),
            language=payload.get("language"),
        )

        transcripts = pipeline.get_transcript(meeting_id, db)
        if transcripts:
            result_data["transcripts"] = [
                {
                    "speaker": item.speaker,
                    "start_time": item.start_time,
                    "end_time": item.end_time,
                    "text": item.text,
                }
                for item in transcripts
            ]

        analysis = pipeline.get_analysis(meeting_id, db)
        if analysis:
            result_data["analysis"] = {
                "summary": analysis.summary,
                "keywords": analysis.keywords,
                "technical_terms": analysis.technical_terms,
                "action_items": analysis.action_items,
                "created_at": analysis.created_at.isoformat()
                if analysis.created_at
                else None,
            }

        set_job_status(
            meeting_id,
            "COMPLETED",
            result=result_data,
            file_id=file_id,
            trace_id=trace_id,
        )
        logger.info(f"[traceId={trace_id}] [jobId={meeting_id}] update COMPLETED")
    except Exception as processing_error:
        logger.exception(
            f"[traceId={trace_id}] [jobId={meeting_id}] processing error: {repr(processing_error)}"
        )
        set_job_status(
            meeting_id,
            "FAILED",
            error="Processing failed",
            file_id=file_id,
            trace_id=trace_id,
        )
        raise
    finally:
        db.close()
