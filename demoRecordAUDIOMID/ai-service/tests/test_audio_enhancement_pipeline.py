from __future__ import annotations

import importlib
import inspect
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.main import final_audio_fallback


class _PipelineGate(Exception):
    """Stop process_meeting after the enhancement/STT/diarization assertions."""


def _load_processing_pipeline(monkeypatch):
    existing = sys.modules.get("app.pipeline")
    if existing is not None:
        return existing.ProcessingPipeline, existing

    audio_processor_stub = types.ModuleType("app.services.audio_processor")
    audio_processor_stub.AudioProcessor = type("AudioProcessor", (), {})
    monkeypatch.setitem(sys.modules, "app.services.audio_processor", audio_processor_stub)
    pipeline_module = importlib.import_module("app.pipeline")
    return pipeline_module.ProcessingPipeline, pipeline_module


def _segments():
    return [{"speaker": "SPEAKER_1", "start": 0.0, "end": 1.0, "text": "hello"}]


@pytest.fixture
def audio_file(tmp_path: Path) -> Path:
    path = tmp_path / "meeting.webm"
    path.write_bytes(b"x" * 256)
    return path


def _base_pipeline(ProcessingPipeline, pipeline_module, monkeypatch):
    monkeypatch.setattr(pipeline_module, "get_runtime_device", lambda: "cpu")
    pipeline = object.__new__(ProcessingPipeline)
    pipeline.audio_processor = types.SimpleNamespace(load_audio=lambda path: None)
    pipeline._ensure_models_loaded = lambda: None
    pipeline._resolve_audio_path = lambda path: Path(path)
    pipeline._record_baseline_snapshot = lambda *args, **kwargs: None
    pipeline._normalize_glossary_terms = lambda *args, **kwargs: []
    pipeline._build_initial_prompt = lambda **kwargs: ""
    pipeline._normalize_batch_language = lambda language: "vi"
    pipeline._deduplicate_repeated_segments = lambda segments: segments
    pipeline._normalize_speaker_labels = lambda segments: segments
    return pipeline


def test_pipeline_enhancement_success_uses_prepared_for_stt_and_diarization(
    monkeypatch, audio_file: Path
):
    ProcessingPipeline, pipeline_module = _load_processing_pipeline(monkeypatch)
    prepared = audio_file.parent / "prepared.wav"
    prepared.write_bytes(b"prepared")
    prepare = MagicMock(return_value=(prepared, prepared))
    monkeypatch.setattr(pipeline_module, "prepare_audio_for_stt", prepare)
    monkeypatch.setattr(pipeline_module.settings, "audio_enhancement_enabled", True)
    monkeypatch.setattr(pipeline_module.settings, "audio_enhancement_provider", "ffmpeg")
    monkeypatch.setattr(pipeline_module.settings, "audio_keep_enhanced_file", False)
    monkeypatch.setattr(pipeline_module.settings, "temp_storage_path", str(audio_file.parent))

    pipeline = _base_pipeline(ProcessingPipeline, pipeline_module, monkeypatch)
    pipeline.diarization_available = True
    pipeline.speaker_diarizer = MagicMock()
    pipeline._should_enable_diarization = lambda runtime_device: True
    pipeline._should_use_native_deepgram_diarization = lambda: False

    def _stt(*, audio_path, **kwargs):
        assert Path(audio_path).name == "prepared.wav"
        return _segments()

    def _diarize(path):
        assert Path(path).name == "prepared.wav"
        raise _PipelineGate("diarization-seen-prepared")

    pipeline._transcribe_with_provider_selection = _stt
    pipeline.speaker_diarizer.diarize.side_effect = _diarize

    with pytest.raises(_PipelineGate, match="diarization-seen-prepared"):
        pipeline.process_meeting(audio_path=str(audio_file), meeting_id=11, db=MagicMock())

    prepare.assert_called_once()


def test_pipeline_enhancement_failure_uses_original(monkeypatch, audio_file: Path):
    ProcessingPipeline, pipeline_module = _load_processing_pipeline(monkeypatch)
    prepare = MagicMock(return_value=(Path(audio_file), None))
    monkeypatch.setattr(pipeline_module, "prepare_audio_for_stt", prepare)
    monkeypatch.setattr(pipeline_module.settings, "audio_enhancement_enabled", True)
    monkeypatch.setattr(pipeline_module.settings, "audio_enhancement_provider", "ffmpeg")
    monkeypatch.setattr(pipeline_module.settings, "audio_keep_enhanced_file", False)
    monkeypatch.setattr(pipeline_module.settings, "temp_storage_path", str(audio_file.parent))

    pipeline = _base_pipeline(ProcessingPipeline, pipeline_module, monkeypatch)
    pipeline.diarization_available = False
    pipeline.speaker_diarizer = None
    pipeline._should_enable_diarization = lambda runtime_device: False
    pipeline._should_use_native_deepgram_diarization = lambda: False

    def _stt(*, audio_path, **kwargs):
        assert Path(audio_path).name == "meeting.webm"
        raise _PipelineGate("stt-seen-original")

    pipeline._transcribe_with_provider_selection = _stt

    with pytest.raises(_PipelineGate, match="stt-seen-original"):
        pipeline.process_meeting(audio_path=str(audio_file), meeting_id=12, db=MagicMock())


def test_pipeline_skips_enhancement_for_precomputed_without_diarization(
    monkeypatch, audio_file: Path
):
    ProcessingPipeline, pipeline_module = _load_processing_pipeline(monkeypatch)
    prepare = MagicMock()
    monkeypatch.setattr(pipeline_module, "prepare_audio_for_stt", prepare)
    monkeypatch.setattr(pipeline_module.settings, "audio_enhancement_enabled", True)

    pipeline = _base_pipeline(ProcessingPipeline, pipeline_module, monkeypatch)
    pipeline.diarization_available = False
    pipeline.speaker_diarizer = None
    pipeline._should_enable_diarization = lambda runtime_device: False
    pipeline._should_use_native_deepgram_diarization = lambda: False
    pipeline.ai_analyzer = MagicMock()
    pipeline.ai_analyzer.format_transcript_for_analysis.side_effect = _PipelineGate(
        "analysis-reached-without-enhancement"
    )

    with pytest.raises(_PipelineGate, match="analysis-reached-without-enhancement"):
        pipeline.process_meeting(
            audio_path=str(audio_file),
            meeting_id=13,
            db=MagicMock(),
            precomputed_transcript_segments=_segments(),
        )

    prepare.assert_not_called()


def test_pipeline_enhances_precomputed_when_local_diarization_needed(
    monkeypatch, audio_file: Path
):
    ProcessingPipeline, pipeline_module = _load_processing_pipeline(monkeypatch)
    prepared = audio_file.parent / "prepared.wav"
    prepared.write_bytes(b"prepared")
    prepare = MagicMock(return_value=(prepared, prepared))
    monkeypatch.setattr(pipeline_module, "prepare_audio_for_stt", prepare)
    monkeypatch.setattr(pipeline_module.settings, "audio_enhancement_enabled", True)
    monkeypatch.setattr(pipeline_module.settings, "audio_enhancement_provider", "ffmpeg")
    monkeypatch.setattr(pipeline_module.settings, "audio_keep_enhanced_file", True)
    monkeypatch.setattr(pipeline_module.settings, "temp_storage_path", str(audio_file.parent))

    pipeline = _base_pipeline(ProcessingPipeline, pipeline_module, monkeypatch)
    pipeline.diarization_available = True
    pipeline.speaker_diarizer = MagicMock()
    pipeline._should_enable_diarization = lambda runtime_device: True
    pipeline._should_use_native_deepgram_diarization = lambda: False

    def _diarize(path):
        assert Path(path).name == "prepared.wav"
        raise _PipelineGate("precomputed-diarization-prepared")

    pipeline.speaker_diarizer.diarize.side_effect = _diarize

    with pytest.raises(_PipelineGate, match="precomputed-diarization-prepared"):
        pipeline.process_meeting(
            audio_path=str(audio_file),
            meeting_id=14,
            db=MagicMock(),
            precomputed_transcript_segments=_segments(),
        )

    prepare.assert_called_once()
    assert prepared.exists()


def test_pipeline_cleanup_after_diarization_when_keep_false(monkeypatch, audio_file: Path):
    ProcessingPipeline, pipeline_module = _load_processing_pipeline(monkeypatch)
    prepared = audio_file.parent / "prepared.wav"
    prepared.write_bytes(b"prepared")
    prepare = MagicMock(return_value=(prepared, prepared))
    monkeypatch.setattr(pipeline_module, "prepare_audio_for_stt", prepare)
    monkeypatch.setattr(pipeline_module.settings, "audio_enhancement_enabled", True)
    monkeypatch.setattr(pipeline_module.settings, "audio_enhancement_provider", "ffmpeg")
    monkeypatch.setattr(pipeline_module.settings, "audio_keep_enhanced_file", False)
    monkeypatch.setattr(pipeline_module.settings, "temp_storage_path", str(audio_file.parent))

    pipeline = _base_pipeline(ProcessingPipeline, pipeline_module, monkeypatch)
    pipeline.diarization_available = True
    pipeline.speaker_diarizer = MagicMock()
    pipeline._should_enable_diarization = lambda runtime_device: True
    pipeline._should_use_native_deepgram_diarization = lambda: False
    pipeline._transcribe_with_provider_selection = MagicMock(return_value=_segments())
    pipeline.speaker_diarizer.diarize.return_value = MagicMock()
    pipeline.speaker_diarizer.format_diarization.return_value = [
        {"speaker": "SPEAKER_1", "start": 0.0, "end": 1.0}
    ]
    pipeline.speaker_diarizer.align_transcript_with_speakers.return_value = _segments()
    pipeline.speaker_diarizer.get_speaker_count.return_value = 1
    pipeline.ai_analyzer = MagicMock()
    pipeline.ai_analyzer.format_transcript_for_analysis.side_effect = _PipelineGate(
        "past-diarization"
    )

    with pytest.raises(_PipelineGate, match="past-diarization"):
        pipeline.process_meeting(audio_path=str(audio_file), meeting_id=15, db=MagicMock())

    # Mid-pipeline cleanup after diarization should have removed prepared file (KEEP=false).
    assert not prepared.exists()
    # finally block is also safe (missing_ok).


def test_final_audio_route_uses_to_thread():
    source = inspect.getsource(final_audio_fallback)
    assert "asyncio.to_thread" in source
    assert "run_final_audio_fallback" in source
