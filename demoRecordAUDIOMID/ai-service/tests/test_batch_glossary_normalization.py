import importlib
import sys
import types

import pytest

import app.tasks as tasks


def _load_processing_pipeline(monkeypatch):
    existing_pipeline_module = sys.modules.get("app.pipeline")
    if existing_pipeline_module is not None:
        return existing_pipeline_module.ProcessingPipeline, existing_pipeline_module

    audio_processor_module = types.ModuleType("app.services.audio_processor")
    audio_processor_module.AudioProcessor = object
    monkeypatch.setitem(
        sys.modules, "app.services.audio_processor", audio_processor_module
    )

    pipeline_module = importlib.import_module("app.pipeline")
    return pipeline_module.ProcessingPipeline, pipeline_module


class _StopAfterStt(Exception):
    pass


def test_normalize_glossary_terms_none_and_missing_returns_empty_list(monkeypatch):
    ProcessingPipeline, _ = _load_processing_pipeline(monkeypatch)
    assert ProcessingPipeline._normalize_glossary_terms(None) == []
    assert ProcessingPipeline._normalize_glossary_terms(None, None) == []


def test_normalize_glossary_terms_empty_list_returns_empty_list(monkeypatch):
    ProcessingPipeline, _ = _load_processing_pipeline(monkeypatch)
    assert ProcessingPipeline._normalize_glossary_terms([]) == []


def test_normalize_glossary_terms_valid_list_preserves_clean_terms(monkeypatch):
    ProcessingPipeline, _ = _load_processing_pipeline(monkeypatch)
    assert ProcessingPipeline._normalize_glossary_terms([" API ", "Docker", ""]) == [
        "API",
        "Docker",
    ]


def test_normalize_glossary_terms_prefers_first_non_none_candidate(monkeypatch):
    ProcessingPipeline, _ = _load_processing_pipeline(monkeypatch)
    assert ProcessingPipeline._normalize_glossary_terms(None, ["Redis"]) == ["Redis"]
    assert ProcessingPipeline._normalize_glossary_terms(["Kafka"], None) == ["Kafka"]


def test_normalize_glossary_terms_invalid_type_returns_empty_list(monkeypatch):
    ProcessingPipeline, _ = _load_processing_pipeline(monkeypatch)
    assert ProcessingPipeline._normalize_glossary_terms({"bad": "type"}) == []
    assert ProcessingPipeline._normalize_glossary_terms(42) == []


def test_process_meeting_none_glossary_reaches_stt_without_len_typeerror(
    monkeypatch, tmp_path
):
    ProcessingPipeline, pipeline_module = _load_processing_pipeline(monkeypatch)
    audio_file = tmp_path / "sample.wav"
    audio_file.write_bytes(b"RIFF")

    captured: dict[str, object] = {}

    def fake_build_initial_prompt(
        self,
        topic=None,
        glossary_terms=None,
        topic_defaults=None,
    ):
        captured["glossary_terms"] = glossary_terms
        assert glossary_terms is not None
        assert len(glossary_terms) == 0
        return "prompt"

    def fake_transcribe(**_kwargs):
        captured["stt_called"] = True
        raise _StopAfterStt()

    monkeypatch.setattr(
        pipeline_module.ProcessingPipeline,
        "_build_initial_prompt",
        fake_build_initial_prompt,
    )

    pipeline = pipeline_module.ProcessingPipeline.__new__(
        pipeline_module.ProcessingPipeline
    )
    pipeline.audio_processor = types.SimpleNamespace(load_audio=lambda _path: None)
    pipeline.diarization_available = False
    pipeline.speaker_diarizer = None
    pipeline._ensure_models_loaded = lambda: None
    pipeline._resolve_audio_path = lambda path: str(audio_file)
    pipeline._record_baseline_snapshot = lambda _meeting_id, _device: None
    pipeline._transcribe_with_provider_selection = lambda **_kwargs: fake_transcribe()
    monkeypatch.setattr(pipeline_module, "get_runtime_device", lambda: "cpu")

    class DummyDB:
        pass

    with pytest.raises(_StopAfterStt):
        pipeline.process_meeting(
            audio_path=str(audio_file),
            meeting_id=3101,
            db=DummyDB(),
            glossary_terms=None,
            glossary_context={"terms": None},
            language="vi",
        )

    assert captured["stt_called"] is True
    assert captured["glossary_terms"] == []


def test_process_meeting_task_records_structured_failure_metadata(monkeypatch):
    class FailingPipeline:
        def process_meeting(self, **_kwargs):
            raise TypeError("object of type 'NoneType' has no len()")

        def get_transcript(self, _meeting_id, _db):
            return []

        def get_analysis(self, _meeting_id, _db):
            return None

    statuses: list[tuple[str, str | None, dict]] = []
    log_events: list[str] = []

    class FakeSessionLocal:
        def __call__(self):
            return types.SimpleNamespace(close=lambda: None)

    def capture_set_job_status(meeting_id, status, error=None, **kwargs):
        statuses.append((status, error, kwargs))

    class FakeLogger:
        def info(self, *_args, **_kwargs):
            return None

        def warning(self, *_args, **_kwargs):
            return None

        def error(self, message, *args, **kwargs):
            log_events.append(message.format(*args, **kwargs))

    monkeypatch.setattr(tasks, "SessionLocal", FakeSessionLocal())
    monkeypatch.setattr(tasks, "pipeline", FailingPipeline())
    monkeypatch.setattr(tasks, "set_job_status", capture_set_job_status)
    monkeypatch.setattr(tasks, "logger", FakeLogger())

    try:
        tasks.process_meeting(
            {
                "meeting_id": 31,
                "audio_path": "/app/uploads/sample.wav",
            }
        )
    except TypeError:
        pass

    failed = [entry for entry in statuses if entry[0] == "FAILED"]
    assert failed
    assert (
        failed[0][1]
        == "BATCH_PIPELINE_FAILED errorType=TypeError stage=speech_recognition"
    )
    assert any(
        "event=BATCH_PIPELINE_FAILED meetingId=31" in event
        and "errorType=TypeError" in event
        and "stage=speech_recognition" in event
        for event in log_events
    )
