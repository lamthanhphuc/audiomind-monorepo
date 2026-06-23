import pytest

pytest.importorskip("opentelemetry")

import app.otel_setup as otel_setup
from opentelemetry import trace


@pytest.fixture(autouse=True)
def reset_tracer_provider():
    """Allow each test to install its own TracerProvider."""
    trace._TRACER_PROVIDER = None  # type: ignore[attr-defined]
    once = getattr(trace, "_TRACER_PROVIDER_SET_ONCE", None)
    if once is not None and hasattr(once, "_done"):
        once._done = False
    yield


def _patch_in_memory_otel_export(monkeypatch):
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )

    memory = InMemorySpanExporter()

    monkeypatch.setattr(
        "opentelemetry.exporter.otlp.proto.http.trace_exporter.OTLPSpanExporter",
        lambda *args, **kwargs: memory,
    )
    monkeypatch.setattr(
        "opentelemetry.sdk.trace.export.BatchSpanProcessor",
        lambda exporter: SimpleSpanProcessor(exporter),
    )
    monkeypatch.setattr(
        "opentelemetry.instrumentation.fastapi.FastAPIInstrumentor.instrument_app",
        lambda app: None,
    )
    return memory


def test_otel_disabled_when_sdk_disabled(monkeypatch):
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert otel_setup.otel_disabled() is True


def test_otel_disabled_without_endpoint(monkeypatch):
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert otel_setup.otel_disabled() is False

    class _App:
        pass

    otel_setup.instrument_fastapi_app(_App())
    # No exception when endpoint missing


def test_bind_trace_id_attribute_noop_when_disabled(monkeypatch):
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    otel_setup.bind_trace_id_attribute("trace-123")


def test_instrument_fastapi_app_registers_tracer_provider(monkeypatch):
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
    monkeypatch.setenv("OTEL_SERVICE_NAME", "ai-service-test")
    _patch_in_memory_otel_export(monkeypatch)

    from opentelemetry.sdk.trace import TracerProvider

    class _App:
        pass

    otel_setup.instrument_fastapi_app(_App())
    provider = trace.get_tracer_provider()
    assert isinstance(provider, TracerProvider)

    tracer = trace.get_tracer("test")
    with tracer.start_as_current_span("health_probe") as span:
        span.set_attribute("audiomind.trace_id", "drill-otel-test")
        assert span.get_span_context().is_valid


def test_bind_trace_id_attribute_on_active_span(monkeypatch):
    monkeypatch.delenv("OTEL_SDK_DISABLED", raising=False)
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")

    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    tracer = trace.get_tracer("test")
    with tracer.start_as_current_span("request"):
        otel_setup.bind_trace_id_attribute("bind-trace-123")

    finished = exporter.get_finished_spans()
    assert finished
    attrs = dict(finished[0].attributes or {})
    assert attrs.get("audiomind.trace_id") == "bind-trace-123"
