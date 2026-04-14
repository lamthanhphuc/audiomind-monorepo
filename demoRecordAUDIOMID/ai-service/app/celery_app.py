from celery import Celery
from celery.signals import worker_ready

from app.config import get_settings
from app.timeout_monitor import start_timeout_monitor
from app.worker_health import start_worker_health_server

settings = get_settings()

celery_app = Celery(
    "ai-service",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

celery_app.conf.update(
    task_default_queue=settings.celery_task_queue,
    task_track_started=True,
    worker_prefetch_multiplier=settings.celery_prefetch_multiplier,
    task_acks_late=True,
    task_time_limit=settings.celery_task_time_limit_seconds,
    task_soft_time_limit=settings.celery_task_soft_time_limit_seconds,
    task_default_retry_delay=2,
)

celery_app.autodiscover_tasks(["app"])


@worker_ready.connect
def _on_worker_ready(**_: dict) -> None:
    start_timeout_monitor()
    start_worker_health_server()
