from loguru import logger

from app.celery_app import celery_app
from app.config import get_settings
from app.database import SessionLocal
from app.job_status_store import set_job_status
from app.services.glossary_repository import GlossaryRepository
from app.services.glossary_service import GlossaryService

try:
    from app.pipeline import ProcessingPipeline
except Exception as pipeline_import_error:
    ProcessingPipeline = None
    logger.warning(
        f"Pipeline modules unavailable in worker: {repr(pipeline_import_error)}"
    )

pipeline = ProcessingPipeline() if ProcessingPipeline is not None else None
settings = get_settings()


def _resolve_glossary_context(payload: dict, db) -> dict | None:
    glossary_ref = payload.get("glossary_ref")
    topic = payload.get("topic")
    if not glossary_ref and not topic:
        return None

    if hasattr(glossary_ref, "model_dump"):
        glossary_ref = glossary_ref.model_dump()

    if glossary_ref is not None and not isinstance(glossary_ref, dict):
        return None
    glossary_ref = glossary_ref or {}

    service = GlossaryService(
        GlossaryRepository(db), cache_ttl_seconds=settings.glossary_cache_ttl_seconds
    )

    glossary_id = glossary_ref.get("glossary_id")
    glossary_version_id = None
    resolved_domain = glossary_ref.get("domain") or topic
    if glossary_id is not None:
        try:
            glossary_version_id = int(glossary_id)
        except (TypeError, ValueError):
            glossary_version_id = None
        if glossary_version_id is not None:
            domain_from_version = service.resolve_domain_for_version(
                glossary_version_id
            )
            if domain_from_version:
                resolved_domain = domain_from_version

    snapshot = service.get_snapshot(resolved_domain)
    requested_hash = glossary_ref.get("version_hash") or snapshot.version_hash
    if (
        glossary_ref.get("version_hash")
        and glossary_ref.get("version_hash") != snapshot.version_hash
    ):
        logger.warning(
            f"Glossary version hash mismatch: requested={glossary_ref.get('version_hash')} resolved={snapshot.version_hash}"
        )

    return {
        "glossary_id": (
            glossary_version_id
            if glossary_version_id is not None
            else snapshot.version_id
        ),
        "domain": resolved_domain,
        "version_id": snapshot.version_id,
        "version_hash": requested_hash,
        "resolved_version_hash": snapshot.version_hash,
        "terms": snapshot.terms,
        "topic_defaults": snapshot.topic_defaults,
        "normalization_map": snapshot.normalization_map,
    }


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

        glossary_context = _resolve_glossary_context(payload, db)

        logger.info(f"[traceId={trace_id}] [jobId={meeting_id}] update RUNNING")
        set_job_status(meeting_id, "RUNNING", file_id=file_id, trace_id=trace_id)

        process_result = pipeline.process_meeting(
            audio_path=payload["audio_path"],
            meeting_id=meeting_id,
            db=db,
            topic=payload.get("topic"),
            glossary_terms=payload.get("glossary_terms"),
            glossary_context=glossary_context,
            language=payload.get("language"),
            trace_id=trace_id,
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

        analysis = None
        if isinstance(process_result, dict):
            analysis = process_result.get("analysis")

        if analysis is None:
            db_analysis = pipeline.get_analysis(meeting_id, db)
            if db_analysis:
                analysis = {
                    "summary": db_analysis.summary,
                    "keywords": db_analysis.keywords,
                    "technical_terms": db_analysis.technical_terms,
                    "action_items": db_analysis.action_items,
                    "created_at": (
                        db_analysis.created_at.isoformat()
                        if db_analysis.created_at
                        else None
                    ),
                    "glossary_domain": getattr(db_analysis, "glossary_domain", None),
                    "glossary_version_id": getattr(
                        db_analysis, "glossary_version_id", None
                    ),
                    "glossary_version_hash": getattr(
                        db_analysis, "glossary_version_hash", None
                    ),
                }

        if analysis:
            result_data["analysis"] = analysis

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
