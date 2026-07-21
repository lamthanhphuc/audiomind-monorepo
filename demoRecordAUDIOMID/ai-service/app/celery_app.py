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
    task_annotations={
        "app.tasks.generate_subject_synthesis": {
            "soft_time_limit": settings.study_generation_soft_time_limit_seconds,
            "time_limit": settings.study_generation_time_limit_seconds,
            "max_retries": settings.study_generation_max_retries,
        },
        "app.tasks.generate_study_artifact": {
            "soft_time_limit": settings.study_generation_soft_time_limit_seconds,
            "time_limit": settings.study_generation_time_limit_seconds,
            "max_retries": settings.study_generation_max_retries,
        },
    },
    task_routes={
        "app.tasks.generate_subject_synthesis": {
            "queue": settings.celery_study_generation_queue,
        },
        "app.tasks.generate_study_artifact": {
            "queue": settings.celery_study_generation_queue,
        },
        "app.tasks.reconcile_study_generation": {
            "queue": settings.celery_study_generation_queue,
        },
    },
    beat_schedule={
        "analysis-retry-scheduled": {
            "task": "app.tasks.analysis_retry_scheduled",
            "schedule": 60.0,
        },
        "study-generation-reconcile": {
            "task": "app.tasks.reconcile_study_generation",
            "schedule": 120.0,
        },
    },
)

celery_app.autodiscover_tasks(["app"])


@worker_ready.connect
def _on_worker_ready(**_: dict) -> None:
    start_timeout_monitor()
    start_worker_health_server()
