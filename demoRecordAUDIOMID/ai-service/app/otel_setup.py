"""Light OpenTelemetry setup for ai-api HTTP tracing."""

from __future__ import annotations

import os

from loguru import logger


def otel_disabled() -> bool:
    value = (os.getenv("OTEL_SDK_DISABLED") or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def instrument_fastapi_app(app) -> None:
    if otel_disabled():
        logger.info("event=OTEL_DISABLED reason=OTEL_SDK_DISABLED")
        return

    endpoint = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        logger.info("event=OTEL_DISABLED reason=missing_OTEL_EXPORTER_OTLP_ENDPOINT")
        return

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as exc:
        logger.warning("event=OTEL_DISABLED reason=missing_dependency error={}", exc)
        return

    service_name = os.getenv("OTEL_SERVICE_NAME", "ai-service")
    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=f"{endpoint.rstrip('/')}/v1/traces")
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(app)
    logger.info(
        "event=OTEL_ENABLED service={} endpoint={}",
        service_name,
        endpoint,
    )


def bind_trace_id_attribute(trace_id: str | None) -> None:
    if not trace_id or otel_disabled():
        return
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        if span is not None and span.get_span_context().is_valid:
            span.set_attribute("audiomind.trace_id", trace_id)
    except Exception:
        return
