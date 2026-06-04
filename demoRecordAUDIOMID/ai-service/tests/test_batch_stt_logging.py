import sys
import builtins
import json
from types import ModuleType, SimpleNamespace

import pytest


class _FakeDeepgramAdapter:
    last_kwargs = None

    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def batch_transcribe_file(self, **kwargs):
        _FakeDeepgramAdapter.last_kwargs = kwargs
        return {"segments": [{"text": "TRANSCRIPT_SHOULD_NOT_APPEAR_IN_LOGS"}]}


class _FailingDeepgramAdapter:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def batch_transcribe_file(self, **kwargs):
        raise RuntimeError("HTTP 422 WriteTimeout")


class _RecordingWhisperRecognizer:
    def __init__(self):
        self.transcribe_calls = []

    def transcribe(self, audio_path, language=None, initial_prompt=None):
        self.transcribe_calls.append(
            {
                "audio_path": audio_path,
                "language": language,
                "initial_prompt": initial_prompt,
            }
        )
        return {
            "segments": [{"start": 0.0, "end": 1.0, "text": "fallback vi transcript"}]
        }

    def format_transcript(self, transcript_result):
        return transcript_result["segments"]


class _ExplodingSpeechRecognizer:
    def __init__(self, *args, **kwargs):
        raise AssertionError("Whisper should not be loaded for Deepgram default")


def test_ensure_models_loaded_skips_whisper_for_deepgram_default(monkeypatch):
    monkeypatch.setitem(sys.modules, "librosa", ModuleType("librosa"))
    monkeypatch.setitem(sys.modules, "soundfile", ModuleType("soundfile"))
    monkeypatch.setitem(sys.modules, "whisper", ModuleType("whisper"))

    import app.pipeline as pipeline_module

    fake_speech_module = ModuleType("app.services.speech_recognizer")
    fake_speech_module.SpeechRecognizer = _ExplodingSpeechRecognizer
    monkeypatch.setitem(
        sys.modules, "app.services.speech_recognizer", fake_speech_module
    )
    monkeypatch.setattr(
        pipeline_module,
        "settings",
        SimpleNamespace(
            stt_provider="deepgram",
            local_whisper_enabled=False,
            allow_legacy_local_stt=False,
            device="cpu",
            enable_speaker_diarization=False,
            deepgram_diarize=False,
        ),
        raising=False,
    )
    monkeypatch.setattr(pipeline_module, "get_runtime_device", lambda: "cpu")

    captured_logs: list[str] = []
    fake_logger = SimpleNamespace(
        info=lambda message, *args, **kwargs: captured_logs.append(
            message.format(*args, **kwargs) if args or kwargs else str(message)
        ),
        warning=lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(pipeline_module, "logger", fake_logger, raising=False)

    pipeline = pipeline_module.ProcessingPipeline.__new__(
        pipeline_module.ProcessingPipeline
    )
    pipeline.speech_recognizer = None
    pipeline.speaker_diarizer = None
    pipeline.ai_analyzer = object()
    pipeline.diarization_available = True

    pipeline._ensure_models_loaded()  # type: ignore[attr-defined]

    assert pipeline.speech_recognizer is None
    assert any("Legacy local STT disabled" in log for log in captured_logs)
    assert any(
        "STT provider deepgram: no Whisper model loaded" in log for log in captured_logs
    )
    assert not any("Runtime device selected" in log for log in captured_logs)


def test_baseline_snapshot_omits_legacy_fields_for_cloud_defaults(
    monkeypatch, tmp_path
):
    import app.pipeline as pipeline_module

    monkeypatch.setattr(
        pipeline_module,
        "settings",
        SimpleNamespace(
            stt_provider="deepgram",
            analysis_provider="gemini",
            local_whisper_enabled=False,
            allow_legacy_local_stt=False,
            allow_legacy_local_ai=False,
            enable_speaker_diarization=True,
            deepgram_diarize=True,
            whisper_model="base",
            ollama_timeout_seconds=300,
        ),
        raising=False,
    )
    monkeypatch.setattr(
        pipeline_module,
        "Path",
        lambda *_args, **_kwargs: tmp_path / "app" / "pipeline.py",
    )
    monkeypatch.setattr(
        pipeline_module,
        "logger",
        SimpleNamespace(info=lambda *args, **kwargs: None),
        raising=False,
    )

    pipeline = pipeline_module.ProcessingPipeline.__new__(
        pipeline_module.ProcessingPipeline
    )
    pipeline.diarization_available = True

    pipeline._record_baseline_snapshot(42, "cpu")  # type: ignore[attr-defined]

    baseline = json.loads((tmp_path / "logs" / "baseline_42.json").read_text())
    assert baseline["stt_provider"] == "deepgram"
    assert baseline["analysis_provider"] == "gemini"
    assert baseline["legacy_local_stt_enabled"] is False
    assert "runtime_device" not in baseline
    assert "whisper_model" not in baseline
    assert "ollama_timeout_seconds" not in baseline


def test_batch_effective_config_log_includes_job_and_trace_context(monkeypatch):
    monkeypatch.setitem(sys.modules, "librosa", ModuleType("librosa"))
    monkeypatch.setitem(sys.modules, "soundfile", ModuleType("soundfile"))
    monkeypatch.setitem(sys.modules, "whisper", ModuleType("whisper"))

    import app.pipeline as pipeline_module

    monkeypatch.setattr(
        pipeline_module,
        "settings",
        SimpleNamespace(
            stt_provider="deepgram",
            deepgram_api_key="test-key",
            deepgram_batch_model="nova-3",
            deepgram_model="nova-2",
            deepgram_base_url="https://api.deepgram.com/v1/listen",
            deepgram_timeout_seconds=30,
            local_whisper_enabled=False,
            allow_legacy_local_stt=False,
            enable_speaker_diarization=False,
            deepgram_diarize=False,
            whisper_model="base",
        ),
        raising=False,
    )
    monkeypatch.setattr(pipeline_module, "DeepgramSTTAdapter", _FakeDeepgramAdapter)

    captured_logs: list[str] = []
    monkeypatch.setattr(
        pipeline_module.logger,
        "info",
        lambda message, *args, **kwargs: captured_logs.append(
            message.format(*args, **kwargs) if args or kwargs else str(message)
        ),
    )

    pipeline = pipeline_module.ProcessingPipeline.__new__(
        pipeline_module.ProcessingPipeline
    )

    result = pipeline._transcribe_with_provider_selection(  # type: ignore[attr-defined]
        audio_path="/tmp/audio.wav",
        language="EN",
        initial_prompt=None,
        meeting_id=42,
        trace_id="trace-abc",
    )

    assert result == [{"text": "TRANSCRIPT_SHOULD_NOT_APPEAR_IN_LOGS"}]
    assert _FakeDeepgramAdapter.last_kwargs == {
        "file_path": "/tmp/audio.wav",
        "language": "en",
        "model": "nova-3",
    }
    expected_audio_bytes = -1
    assert any(
        log.startswith(
            "BATCH_STT_EFFECTIVE_CONFIG jobId=42 traceId=trace-abc model=nova-3 language=en"
        )
        and f"audioBytes={expected_audio_bytes}" in log
        and "deepgramTimeoutSeconds=30" in log
        for log in captured_logs
    )
    assert any(
        log.startswith("event=BATCH_STT_DIAGNOSTIC_START ")
        and "requestedLanguage=EN" in log
        and "effectiveLanguage=en" in log
        and "model=nova-3" in log
        and f"audioBytes={expected_audio_bytes}" in log
        and "deepgramTimeoutSeconds=30" in log
        for log in captured_logs
    )
    assert any(
        log.startswith("event=BATCH_STT_DIAGNOSTIC_CONFIG ")
        and "deepgramLanguage=en" in log
        and "smartFormat=True" in log
        and "utterances=True" in log
        and f"audioBytes={expected_audio_bytes}" in log
        and "deepgramTimeoutSeconds=30" in log
        for log in captured_logs
    )
    assert any(
        log.startswith("event=BATCH_STT_DIAGNOSTIC_COMPLETED ")
        and "transcriptLength=36" in log
        and "providerStatus=ok" in log
        and "errorCode=none" in log
        and "timeoutType=none" in log
        and f"audioBytes={expected_audio_bytes}" in log
        and "deepgramTimeoutSeconds=30" in log
        for log in captured_logs
    )
    assert not any(
        "TRANSCRIPT_SHOULD_NOT_APPEAR_IN_LOGS" in log for log in captured_logs
    )


def test_batch_multi_failure_skips_whisper_fallback_with_safe_error(monkeypatch):
    monkeypatch.setitem(sys.modules, "librosa", ModuleType("librosa"))
    monkeypatch.setitem(sys.modules, "soundfile", ModuleType("soundfile"))
    monkeypatch.setitem(sys.modules, "whisper", ModuleType("whisper"))

    import app.pipeline as pipeline_module

    monkeypatch.setattr(
        pipeline_module,
        "settings",
        SimpleNamespace(
            stt_provider="deepgram",
            deepgram_api_key="test-key",
            deepgram_batch_model="nova-3",
            deepgram_model="nova-2",
            deepgram_base_url="https://api.deepgram.com/v1/listen",
            deepgram_timeout_seconds=30,
            local_whisper_enabled=True,
            allow_legacy_local_stt=False,
            enable_speaker_diarization=False,
            deepgram_diarize=False,
            whisper_model="base",
        ),
        raising=False,
    )
    monkeypatch.setattr(pipeline_module, "DeepgramSTTAdapter", _FailingDeepgramAdapter)

    captured_warning_logs: list[str] = []
    fake_logger = SimpleNamespace(
        info=lambda *args, **kwargs: None,
        warning=lambda message, *args, **kwargs: captured_warning_logs.append(
            message.format(*args, **kwargs) if args or kwargs else str(message)
        ),
        error=lambda *args, **kwargs: None,
        exception=lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(pipeline_module, "logger", fake_logger, raising=False)

    pipeline = pipeline_module.ProcessingPipeline.__new__(
        pipeline_module.ProcessingPipeline
    )
    pipeline._ensure_models_loaded = lambda: None  # type: ignore[attr-defined]
    pipeline.speech_recognizer = _RecordingWhisperRecognizer()

    with pytest.raises(RuntimeError) as error_info:
        pipeline._transcribe_with_provider_selection(  # type: ignore[attr-defined]
            audio_path="/tmp/audio.wav",
            language="multi",
            initial_prompt=None,
            meeting_id=42,
            trace_id="trace-abc",
        )

    error_message = str(error_info.value)
    assert "STT_PROVIDER_UNAVAILABLE" in error_message
    assert "DEEPGRAM_STT_FAILED" in error_message
    assert "Unsupported language" not in error_message
    assert pipeline.speech_recognizer.transcribe_calls == []
    assert any(
        log.startswith("event=BATCH_STT_FALLBACK_SKIPPED ")
        and "fallbackSkipped=True" in log
        and "fallbackReason=multi_not_supported_by_local_whisper" in log
        and "timeoutType=none" in log
        and "providerStatus=unavailable" in log
        for log in captured_warning_logs
    )


def test_batch_vi_failure_blocks_whisper_without_legacy_opt_in(monkeypatch):
    monkeypatch.setitem(sys.modules, "librosa", ModuleType("librosa"))
    monkeypatch.setitem(sys.modules, "soundfile", ModuleType("soundfile"))
    monkeypatch.setitem(sys.modules, "whisper", ModuleType("whisper"))

    import app.pipeline as pipeline_module

    monkeypatch.setattr(
        pipeline_module,
        "settings",
        SimpleNamespace(
            stt_provider="deepgram",
            deepgram_api_key="test-key",
            deepgram_batch_model="nova-3",
            deepgram_model="nova-3",
            deepgram_base_url="https://api.deepgram.com/v1/listen",
            deepgram_timeout_seconds=30,
            local_whisper_enabled=True,
            allow_legacy_local_stt=False,
            enable_speaker_diarization=False,
            deepgram_diarize=False,
            whisper_model="base",
        ),
        raising=False,
    )
    monkeypatch.setattr(pipeline_module, "DeepgramSTTAdapter", _FailingDeepgramAdapter)

    whisper = _RecordingWhisperRecognizer()
    pipeline = pipeline_module.ProcessingPipeline.__new__(
        pipeline_module.ProcessingPipeline
    )
    pipeline._ensure_models_loaded = lambda: None  # type: ignore[attr-defined]
    pipeline.speech_recognizer = whisper

    with pytest.raises(RuntimeError, match="legacy local STT fallback disabled"):
        pipeline._transcribe_with_provider_selection(  # type: ignore[attr-defined]
            audio_path="/tmp/audio.wav",
            language="vi",
            initial_prompt="prompt",
            meeting_id=123,
            trace_id="trace-123",
        )

    assert whisper.transcribe_calls == []


def test_batch_vi_failure_allows_whisper_with_legacy_opt_in(monkeypatch):
    monkeypatch.setitem(sys.modules, "librosa", ModuleType("librosa"))
    monkeypatch.setitem(sys.modules, "soundfile", ModuleType("soundfile"))
    monkeypatch.setitem(sys.modules, "whisper", ModuleType("whisper"))

    import app.pipeline as pipeline_module

    monkeypatch.setattr(
        pipeline_module,
        "settings",
        SimpleNamespace(
            stt_provider="deepgram",
            deepgram_api_key="test-key",
            deepgram_batch_model="nova-3",
            deepgram_model="nova-3",
            deepgram_base_url="https://api.deepgram.com/v1/listen",
            deepgram_timeout_seconds=30,
            local_whisper_enabled=True,
            allow_legacy_local_stt=True,
            enable_speaker_diarization=False,
            deepgram_diarize=False,
            whisper_model="base",
        ),
        raising=False,
    )
    monkeypatch.setattr(pipeline_module, "DeepgramSTTAdapter", _FailingDeepgramAdapter)

    whisper = _RecordingWhisperRecognizer()
    pipeline = pipeline_module.ProcessingPipeline.__new__(
        pipeline_module.ProcessingPipeline
    )
    pipeline._ensure_models_loaded = lambda: None  # type: ignore[attr-defined]
    pipeline.speech_recognizer = whisper

    result = pipeline._transcribe_with_provider_selection(  # type: ignore[attr-defined]
        audio_path="/tmp/audio.wav",
        language="vi",
        initial_prompt="prompt",
        meeting_id=123,
        trace_id="trace-123",
    )

    assert result == [{"start": 0.0, "end": 1.0, "text": "fallback vi transcript"}]
    assert len(whisper.transcribe_calls) == 1
    assert whisper.transcribe_calls[0]["language"] == "vi"


def test_local_whisper_opt_in_without_dependencies_has_clear_error(monkeypatch):
    import app.pipeline as pipeline_module

    real_import = builtins.__import__

    monkeypatch.setattr(
        pipeline_module,
        "settings",
        SimpleNamespace(
            stt_provider="local_whisper",
            local_whisper_enabled=True,
            allow_legacy_local_stt=True,
            whisper_model="base",
            whisper_no_speech_threshold=0.7,
            whisper_logprob_threshold=-0.8,
            whisper_cpu_chunk_seconds=30,
            whisper_gpu_chunk_seconds=60,
        ),
        raising=False,
    )
    monkeypatch.delitem(sys.modules, "app.services.speech_recognizer", raising=False)
    monkeypatch.delitem(sys.modules, "whisper", raising=False)
    monkeypatch.setattr(
        builtins,
        "__import__",
        lambda name, *args, **kwargs: (
            (_ for _ in ()).throw(ModuleNotFoundError(name="whisper"))
            if name == "whisper"
            else real_import(name, *args, **kwargs)
        ),
    )

    pipeline = pipeline_module.ProcessingPipeline.__new__(
        pipeline_module.ProcessingPipeline
    )
    pipeline.speech_recognizer = None

    with pytest.raises(RuntimeError, match="INSTALL_OFFLINE_STT=true"):
        pipeline._ensure_speech_recognizer_loaded(runtime_device="cpu")  # type: ignore[attr-defined]
