from celery import Celery

from app.config import get_settings

settings = get_settings()

celery_app = Celery(
    "ai-service",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
)

celery_app.conf.update(
    task_default_queue=settings.celery_task_queue,
    task_track_started=True,
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    task_time_limit=settings.celery_task_time_limit_seconds,
)

celery_app.autodiscover_tasks(["app"])
