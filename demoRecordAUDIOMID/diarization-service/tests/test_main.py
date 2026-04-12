import importlib
import sys
from pathlib import Path

import numpy as np
import pytest


SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


def load_module():
    if "app.main" in sys.modules:
        del sys.modules["app.main"]
    return importlib.import_module("app.main")


def test_diarize_lightweight_returns_single_segment_for_silence(monkeypatch):
    main = load_module()

    monkeypatch.setattr(main.librosa, "load", lambda *_args, **_kwargs: (np.zeros(16000), 16000))
    monkeypatch.setattr(main.librosa.effects, "split", lambda *_args, **_kwargs: np.array([]))
    monkeypatch.setattr(main.librosa, "get_duration", lambda **_kwargs: 1.0)

    segments = main.runtime.diarize_lightweight("dummy.wav")

    assert segments == [{"speaker": "SPEAKER_1", "start": 0.0, "end": 1.0}]


def test_diarize_lightweight_alternates_speakers_and_skips_invalid(monkeypatch):
    main = load_module()

    monkeypatch.setattr(main.librosa, "load", lambda *_args, **_kwargs: (np.ones(32000), 16000))
    monkeypatch.setattr(
        main.librosa.effects,
        "split",
        lambda *_args, **_kwargs: np.array([[0, 8000], [8000, 8000], [9000, 16000]]),
    )

    segments = main.runtime.diarize_lightweight("dummy.wav")

    assert segments == [
        {"speaker": "SPEAKER_1", "start": 0.0, "end": 0.5},
        {"speaker": "SPEAKER_2", "start": 0.56, "end": 1.0},
    ]


def test_diarize_endpoint_returns_404_when_file_missing():
    main = load_module()
    payload = main.DiarizeRequest(audio_path="/tmp/does-not-exist.wav")

    with pytest.raises(main.HTTPException) as exc_info:
        main.diarize(payload)

    assert exc_info.value.status_code == 404
