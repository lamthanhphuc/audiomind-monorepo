"""Contracts for optional audio enhancement providers."""

from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Protocol


class AudioEnhancementProviderName(str, Enum):
    NONE = "none"
    FFMPEG = "ffmpeg"
    ELEVENLABS = "elevenlabs"
    DEEPFILTER = "deepfilter"


class AudioEnhancementProfile(str, Enum):
    STT = "stt"
    PLAYBACK = "playback"


class AudioEnhancementProvider(Protocol):
    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        profile: AudioEnhancementProfile,
    ) -> Path: ...
