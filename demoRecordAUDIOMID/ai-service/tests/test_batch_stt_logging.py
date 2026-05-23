import sys
from types import ModuleType, SimpleNamespace


class _FakeDeepgramAdapter:
    last_kwargs = None

    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def batch_transcribe_file(self, **kwargs):
        _FakeDeepgramAdapter.last_kwargs = kwargs
        return {"segments": [{"text": "ok"}]}


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

    assert result == [{"text": "ok"}]
    assert _FakeDeepgramAdapter.last_kwargs == {
        "file_path": "/tmp/audio.wav",
        "language": "en",
        "model": "nova-3",
    }
    assert any(
        log
        == "BATCH_STT_EFFECTIVE_CONFIG jobId=42 traceId=trace-abc model=nova-3 language=en"
        for log in captured_logs
    )
