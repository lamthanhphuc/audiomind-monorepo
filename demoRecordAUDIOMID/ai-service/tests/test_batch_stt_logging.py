import sys
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


def test_batch_vi_failure_keeps_existing_whisper_fallback(monkeypatch):
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
