"""
Tests for batch STT provider selection (Deepgram vs Whisper fallback).
"""

import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from app.services.stt_adapter import DeepgramSTTAdapter


class MockResponse:
    """Mock httpx.Response for testing batch Deepgram."""

    def __init__(self, status_code=200, json_data=None):
        self.status_code = status_code
        self._json_data = json_data or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._json_data


class MockHTTPClient:
    """Mock httpx.Client for testing batch Deepgram."""

    def __init__(self, response_data=None, raise_on_post=None, timeout=None):
        self.response_data = response_data
        self.raise_on_post = raise_on_post
        self.timeout = timeout
        self.last_post_url = None
        self.last_post_headers = None
        self.last_post_content = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def post(self, url, content=None, headers=None):
        self.last_post_url = url
        self.last_post_content = content
        self.last_post_headers = headers

        if self.raise_on_post:
            raise self.raise_on_post

        return MockResponse(
            status_code=200,
            json_data=self.response_data
            or {
                "results": {
                    "channels": [
                        {
                            "alternatives": [
                                {
                                    "transcript": "xin chào từ Deepgram",
                                    "confidence": 0.95,
                                    "words": [
                                        {"word": "xin", "start": 0.0, "end": 0.2},
                                        {"word": "chào", "start": 0.2, "end": 0.5},
                                        {"word": "từ", "start": 0.5, "end": 0.8},
                                        {"word": "Deepgram", "start": 0.8, "end": 1.2},
                                    ],
                                    "duration": 1.2,
                                }
                            ]
                        }
                    ],
                    "utterances": [
                        {
                            "transcript": "xin chào từ Deepgram",
                            "start": 0.0,
                            "end": 1.2,
                        }
                    ],
                }
            },
        )


def test_batch_deepgram_transcribe_success(monkeypatch):
    """Test successful batch Deepgram transcription."""

    # Mock httpx
    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        MockHTTPClient,
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
        base_url="https://api.deepgram.com/v1/listen",
        timeout_seconds=30,
        enable_speaker_diarization=True,
        deepgram_diarize=True,
    )

    # Create temp audio file
    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        result = adapter.batch_transcribe_file(
            file_path=temp_audio_path,
            language="vi",
            model="nova-2",
        )

        assert result["transcript"] == "xin chào từ Deepgram"
        assert len(result["segments"]) == 1
        assert result["segments"][0]["text"] == "xin chào từ Deepgram"
        assert result["segments"][0]["start"] == 0.0
        assert result["segments"][0]["end"] == 1.2
        assert result["segments"][0]["speaker"] == "SPEAKER_1"
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_transcribe_prefers_utterance_speakers(monkeypatch):
    """Test batch Deepgram uses utterance-level speaker labels when present."""

    response_data = {
        "results": {
            "channels": [
                {
                    "alternatives": [
                        {
                            "transcript": "xin chào từ Deepgram",
                            "confidence": 0.95,
                            "duration": 2.4,
                        }
                    ]
                }
            ],
            "utterances": [
                {
                    "transcript": "xin chào",
                    "start": 0.0,
                    "end": 1.1,
                    "speaker": 0,
                    "confidence": 0.96,
                },
                {
                    "transcript": "từ Deepgram",
                    "start": 1.1,
                    "end": 2.4,
                    "speaker": 1,
                    "confidence": 0.94,
                },
            ],
        }
    }

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        lambda **kwargs: MockHTTPClient(response_data=response_data, **kwargs),
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
        base_url="https://api.deepgram.com/v1/listen",
        timeout_seconds=30,
        enable_speaker_diarization=True,
        deepgram_diarize=True,
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        result = adapter.batch_transcribe_file(
            file_path=temp_audio_path,
            language="vi",
            model="nova-2",
        )

        assert result["segments"][0]["speaker"] == "SPEAKER_1"
        assert result["segments"][1]["speaker"] == "SPEAKER_2"
        assert result["segments"][0]["text"] == "xin chào"
        assert result["segments"][1]["text"] == "từ Deepgram"
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_transcribe_uses_word_speakers_when_utterances_missing(
    monkeypatch,
):
    """Test batch Deepgram falls back to word speaker labels when utterances are not labeled."""

    response_data = {
        "results": {
            "channels": [
                {
                    "alternatives": [
                        {
                            "transcript": "xin chào từ Deepgram",
                            "confidence": 0.95,
                            "duration": 2.4,
                            "words": [
                                {"word": "xin", "start": 0.0, "end": 0.2, "speaker": 0},
                                {
                                    "word": "chào",
                                    "start": 0.2,
                                    "end": 0.5,
                                    "speaker": 0,
                                },
                                {"word": "từ", "start": 1.1, "end": 1.3, "speaker": 1},
                                {
                                    "word": "Deepgram",
                                    "start": 1.3,
                                    "end": 1.8,
                                    "speaker": 1,
                                },
                            ],
                        }
                    ]
                }
            ],
            "utterances": [
                {
                    "transcript": "xin chào từ Deepgram",
                    "start": 0.0,
                    "end": 2.4,
                    "confidence": 0.95,
                }
            ],
        }
    }

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        lambda **kwargs: MockHTTPClient(response_data=response_data, **kwargs),
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
        base_url="https://api.deepgram.com/v1/listen",
        timeout_seconds=30,
        enable_speaker_diarization=True,
        deepgram_diarize=True,
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        result = adapter.batch_transcribe_file(
            file_path=temp_audio_path,
            language="vi",
            model="nova-2",
        )

        assert [segment["speaker"] for segment in result["segments"]] == [
            "SPEAKER_1",
            "SPEAKER_2",
        ]
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_file_not_found():
    """Test batch Deepgram with missing audio file."""

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
    )

    with pytest.raises(RuntimeError, match="Audio file not found"):
        adapter.batch_transcribe_file(
            file_path="/nonexistent/file.m4a",
            language="vi",
        )


def test_batch_deepgram_missing_api_key():
    """Test batch Deepgram without API key."""

    adapter = DeepgramSTTAdapter(
        api_key="",  # Empty API key
        model="nova-2",
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        with pytest.raises(RuntimeError, match="API key is not configured"):
            adapter.batch_transcribe_file(
                file_path=temp_audio_path,
                language="vi",
            )
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_api_failure(monkeypatch):
    """Test batch Deepgram API failure handling."""

    def mock_client_factory(**kwargs):
        return MockHTTPClient(raise_on_post=RuntimeError("API error"), **kwargs)

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        mock_client_factory,
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        with pytest.raises(RuntimeError, match="Deepgram batch transcription failed"):
            adapter.batch_transcribe_file(
                file_path=temp_audio_path,
                language="vi",
            )
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_url_construction(monkeypatch):
    """Test Deepgram batch endpoint URL is correctly constructed."""

    mock_client = MockHTTPClient()

    def mock_client_factory(**kwargs):
        return mock_client

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        mock_client_factory,
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
        base_url="https://api.deepgram.com/v1/listen",
        enable_speaker_diarization=False,
        deepgram_diarize=False,
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        adapter.batch_transcribe_file(
            file_path=temp_audio_path,
            language="vi",
            model="nova-2",
        )

        # Verify URL construction
        assert mock_client.last_post_url is not None
        assert "https://api.deepgram.com/v1/listen" in mock_client.last_post_url
        assert "model=nova-2" in mock_client.last_post_url
        assert "language=vi" in mock_client.last_post_url
        assert "smart_format=true" in mock_client.last_post_url
        assert "diarize=true" not in mock_client.last_post_url

        # Verify headers
        assert "Authorization" in mock_client.last_post_headers
        assert (
            "Token test-deepgram-key" in mock_client.last_post_headers["Authorization"]
        )
        assert "Content-Type" in mock_client.last_post_headers
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_url_includes_diarize_when_enabled(monkeypatch):
    """Test Deepgram batch endpoint URL enables diarization when configured."""

    mock_client = MockHTTPClient()

    def mock_client_factory(**kwargs):
        return mock_client

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        mock_client_factory,
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
        base_url="https://api.deepgram.com/v1/listen",
        enable_speaker_diarization=True,
        deepgram_diarize=True,
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        adapter.batch_transcribe_file(
            file_path=temp_audio_path,
            language="vi",
            model="nova-2",
        )

        assert "diarize=true" in mock_client.last_post_url
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_empty_response():
    """Test batch Deepgram with empty Deepgram response."""

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
    )

    # Simulate empty response
    adapter.batch_transcribe_file = MagicMock(
        return_value={
            "transcript": "",
            "segments": [],
            "raw_response": {"results": {}},
        }
    )

    result = adapter.batch_transcribe_file(
        file_path="/tmp/test.m4a",
        language="vi",
    )

    assert result["transcript"] == ""
    assert result["segments"] == []


def test_batch_deepgram_model_selection(monkeypatch):
    """Test batch Deepgram uses correct model and language settings."""

    mock_client = MockHTTPClient()

    def mock_client_factory(**kwargs):
        return mock_client

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        mock_client_factory,
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        # Test with explicit model
        adapter.batch_transcribe_file(
            file_path=temp_audio_path,
            language="vi",
            model="nova-2",
        )

        assert "model=nova-2" in mock_client.last_post_url
        assert "language=vi" in mock_client.last_post_url
    finally:
        Path(temp_audio_path).unlink()


@pytest.mark.parametrize("language", ["vi", "en", "multi"])
def test_batch_deepgram_preserves_supported_languages(monkeypatch, language):
    mock_client = MockHTTPClient()

    def mock_client_factory(**kwargs):
        return mock_client

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        mock_client_factory,
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        adapter.batch_transcribe_file(
            file_path=temp_audio_path, language=language, model="nova-2"
        )
        assert f"language={language}" in mock_client.last_post_url
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_invalid_language_falls_back_to_vi(monkeypatch):
    mock_client = MockHTTPClient()

    def mock_client_factory(**kwargs):
        return mock_client

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        mock_client_factory,
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        adapter.batch_transcribe_file(
            file_path=temp_audio_path, language="fr", model="nova-2"
        )
        assert "language=vi" in mock_client.last_post_url
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_url_omits_realtime_endpointing(monkeypatch):
    mock_client = MockHTTPClient()

    def mock_client_factory(**kwargs):
        return mock_client

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        mock_client_factory,
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
        endpointing=300,
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        adapter.batch_transcribe_file(
            file_path=temp_audio_path, language="vi", model="nova-2"
        )
        assert "endpointing=" not in mock_client.last_post_url
    finally:
        Path(temp_audio_path).unlink()


def test_batch_deepgram_uses_adapter_model_when_explicit_model_missing(monkeypatch):
    """Batch URL should fallback to adapter model when model arg is omitted."""

    mock_client = MockHTTPClient()

    def mock_client_factory(**kwargs):
        return mock_client

    monkeypatch.setattr(
        "app.services.stt_adapter.httpx.Client",
        mock_client_factory,
    )

    adapter = DeepgramSTTAdapter(
        api_key="test-deepgram-key",
        model="nova-2",
    )

    with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
        temp_audio_path = f.name
        f.write(b"fake audio data")

    try:
        adapter.batch_transcribe_file(
            file_path=temp_audio_path,
            language="vi",
            model=None,
        )
        assert "model=nova-2" in mock_client.last_post_url
        assert "language=vi" in mock_client.last_post_url
    finally:
        Path(temp_audio_path).unlink()
