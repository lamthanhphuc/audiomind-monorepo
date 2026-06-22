from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

STRICT_MAX_UPLOAD_BYTES = 104_857_600
STRICT_ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a"}


@lru_cache()
def load_upload_validation_policy() -> dict[str, object]:
    candidates = [
        Path(__file__).resolve().parents[3] / "packages" / "contracts" / "upload-validation-policy.json",
        Path(__file__).resolve().parents[2] / "upload-validation-policy.json",
    ]
    for candidate in candidates:
        if candidate.is_file():
            with candidate.open("r", encoding="utf-8") as handle:
                return json.load(handle)
    return {
        "maxUploadBytes": STRICT_MAX_UPLOAD_BYTES,
        "allowedExtensions": sorted(STRICT_ALLOWED_EXTENSIONS),
    }


def effective_max_upload_bytes(*, strict: bool, legacy_max_bytes: int) -> int:
    if not strict:
        return legacy_max_bytes
    policy = load_upload_validation_policy()
    return int(policy.get("maxUploadBytes", STRICT_MAX_UPLOAD_BYTES))


def effective_allowed_extensions(*, strict: bool, legacy_extensions: str) -> set[str]:
    if not strict:
        return {
            item.strip().lower()
            for item in legacy_extensions.split(",")
            if item.strip()
        }
    policy = load_upload_validation_policy()
    raw = policy.get("allowedExtensions", [])
    if not isinstance(raw, list):
        return set(STRICT_ALLOWED_EXTENSIONS)
    return {
        str(item).strip().lower() if str(item).startswith(".") else f".{str(item).strip().lower()}"
        for item in raw
        if str(item).strip()
    } or set(STRICT_ALLOWED_EXTENSIONS)


def effective_realtime_max_chunk_bytes() -> int:
    policy = load_upload_validation_policy()
    realtime = policy.get("realtime")
    if isinstance(realtime, dict):
        return int(realtime.get("maxChunkBytes", 1_048_576))
    return 1_048_576
