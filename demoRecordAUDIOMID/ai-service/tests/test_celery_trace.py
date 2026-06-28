"""Tests for Celery OTEL trace bridge (Beta-Ops L2)."""

from unittest.mock import patch

import pytest

from app.observability.celery_trace import celery_task_span


def test_celery_task_span_logs_when_otel_disabled(monkeypatch):
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    with celery_task_span("canonicalize_and_persist", meeting_id=42, trace_id="trace-42"):
        pass


def test_celery_task_span_creates_span_when_otel_enabled(monkeypatch):
    pytest.importorskip("opentelemetry")
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")

    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )
    from opentelemetry import trace

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    with celery_task_span("canonicalize_deferred_retry", meeting_id=7, trace_id="t-7"):
        pass

    finished = exporter.get_finished_spans()
    assert finished
    assert finished[0].name == "celery.canonicalize_deferred_retry"
