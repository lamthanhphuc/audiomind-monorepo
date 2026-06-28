"""Light Celery task tracing — bridges audiomind traceId to OTEL spans (Beta-Ops L2)."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from loguru import logger

from app.otel_setup import bind_trace_id_attribute, otel_disabled


@contextmanager
def celery_task_span(
    task_name: str,
    *,
    meeting_id: int | None = None,
    trace_id: str | None = None,
) -> Iterator[None]:
    """Create a child span for Celery work when OTEL is enabled."""
    if otel_disabled():
        if trace_id:
            logger.info(
                "event=CELERY_TASK_START task={} meetingId={} traceId={}",
                task_name,
                meeting_id,
                trace_id,
            )
        try:
            yield
        finally:
            if trace_id:
                logger.info(
                    "event=CELERY_TASK_END task={} meetingId={} traceId={}",
                    task_name,
                    meeting_id,
                    trace_id,
                )
        return

    span = None
    try:
        from opentelemetry import trace

        tracer = trace.get_tracer("audiomind.celery")
        span = tracer.start_as_current_span(
            f"celery.{task_name}",
            attributes={
                "audiomind.task": task_name,
                **(
                    {"audiomind.meeting_id": meeting_id}
                    if meeting_id is not None
                    else {}
                ),
            },
        )
        span.__enter__()
        bind_trace_id_attribute(trace_id)
        if trace_id:
            logger.info(
                "event=CELERY_TASK_START task={} meetingId={} traceId={}",
                task_name,
                meeting_id,
                trace_id,
            )
        yield
    except ImportError:
        yield
    finally:
        if span is not None:
            try:
                span.__exit__(None, None, None)
            except Exception:
                pass
        if trace_id:
            logger.info(
                "event=CELERY_TASK_END task={} meetingId={} traceId={}",
                task_name,
                meeting_id,
                trace_id,
            )
