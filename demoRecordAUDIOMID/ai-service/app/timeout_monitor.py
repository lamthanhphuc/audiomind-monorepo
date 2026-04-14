from __future__ import annotations

from datetime import datetime, timezone
import threading
import time

from loguru import logger

from app.config import get_settings
from app.job_status_store import force_fail_job, get_job_status, list_running_job_ids

settings = get_settings()
_monitor_started = False
_monitor_lock = threading.Lock()


def _parse_iso_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _monitor_loop() -> None:
    interval = max(5, int(settings.timeout_monitor_interval_seconds))
    threshold_seconds = max(60, int(settings.timeout_monitor_threshold_seconds))

    while True:
        now = datetime.now(timezone.utc)
        for job_id in list_running_job_ids():
            state = get_job_status(job_id)
            if not state:
                continue

            updated_at = _parse_iso_utc(state.get("updatedAt"))
            if updated_at is None:
                continue

            elapsed = (now - updated_at).total_seconds()
            if elapsed <= threshold_seconds:
                continue

            trace_id = state.get("traceId")
            logger.bind(traceId=trace_id, jobId=str(job_id)).warning(
                "Timeout monitor forcing FAILED due to stale RUNNING state"
            )
            force_fail_job(job_id, "timeout_monitor")

        time.sleep(interval)


def start_timeout_monitor() -> None:
    global _monitor_started
    with _monitor_lock:
        if _monitor_started:
            return
        worker = threading.Thread(
            target=_monitor_loop,
            name="job-timeout-monitor",
            daemon=True,
        )
        worker.start()
        _monitor_started = True
        logger.info("Timeout monitor started")
