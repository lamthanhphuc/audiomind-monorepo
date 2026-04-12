import importlib
import sys
import types
from pathlib import Path

import pytest


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


def load_module(monkeypatch):
    fake_torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: False),
    )
    fake_whisper = types.SimpleNamespace(load_model=lambda *args, **kwargs: object())

    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    monkeypatch.setitem(sys.modules, "whisper", fake_whisper)

    if "app.main" in sys.modules:
        del sys.modules["app.main"]

    return importlib.import_module("app.main")


def test_runtime_uses_cpu_when_cuda_unavailable(monkeypatch):
    main = load_module(monkeypatch)
    runtime = main.WhisperRuntime()
    assert runtime.device == "cpu"


def test_transcribe_returns_404_for_missing_file(monkeypatch):
    main = load_module(monkeypatch)
    main.runtime.ensure_ready = lambda: None
    main.runtime.model = object()

    payload = main.TranscribeRequest(audio_path="/tmp/does-not-exist.wav", language="en")
    with pytest.raises(main.HTTPException) as exc_info:
        main.transcribe(payload)

    assert exc_info.value.status_code == 404


def test_transcribe_formats_response(monkeypatch, tmp_path):
    main = load_module(monkeypatch)

    class DummyModel:
        def transcribe(self, *_args, **_kwargs):
            return {
                "text": " hello world ",
                "language": "en",
                "segments": [
                    {"start": 1, "end": 2.5, "text": " hi "},
                    {"start": 3.0, "end": 4.0, "text": " there "},
                ],
            }

    main.runtime.ensure_ready = lambda: None
    main.runtime.model = DummyModel()

    audio_file = tmp_path / "sample.wav"
    audio_file.write_bytes(b"test")

    payload = main.TranscribeRequest(audio_path=str(audio_file), language="en")
    result = main.transcribe(payload)

    assert result["text"] == "hello world"
    assert result["segments"][0] == {"start": 1.0, "end": 2.5, "text": "hi"}
    assert result["device"] == "cpu"
