from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Callable

logger = logging.getLogger(__name__)

MAX_SNIFF_BYTES = 64 * 1024
AMBIGUOUS_MIME_TYPES = {
    "application/octet-stream",
    "application/binary",
    "binary/octet-stream",
}
EXTENSION_EXPECTED_MIMES: dict[str, set[str]] = {
    ".mp3": {"audio/mpeg", "audio/mp3", "audio/x-mpeg", "audio/mpeg3"},
    ".wav": {"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"},
    ".m4a": {"audio/mp4", "audio/x-m4a", "audio/aac", "audio/x-aac", "video/mp4"},
}
ALLOWED_MIME_TYPES = {
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/aac",
    "audio/x-m4a",
}


class MimeClassification(str, Enum):
    CONFIDENT_MISMATCH = "CONFIDENT_MISMATCH"
    AMBIGUOUS = "AMBIGUOUS"
    UNKNOWN = "UNKNOWN"
    MATCH = "MATCH"


@dataclass(frozen=True)
class MimeSniffResult:
    classification: MimeClassification
    detected_mime: str
    from_cache: bool = False


_request_cache: dict[str, MimeSniffResult] = {}


def reset_request_cache() -> None:
    _request_cache.clear()


def _normalize_mime(value: str) -> str:
    return value.split(";", 1)[0].strip().lower()


def _normalize_extension(extension: str) -> str:
    normalized = extension.strip().lower()
    return normalized if normalized.startswith(".") else f".{normalized}"


def _content_hash_prefix(sample: bytes) -> str:
    return hashlib.sha256(sample).hexdigest()[:16]


def _is_confident_mismatch(normalized_mime: str) -> bool:
    return (
        normalized_mime.startswith("application/x-msdownload")
        or normalized_mime.startswith("application/vnd.microsoft")
        or normalized_mime.startswith("application/x-executable")
        or normalized_mime.startswith("application/x-dosexec")
        or normalized_mime.startswith("application/x-msdos-program")
        or normalized_mime == "application/zip"
        or normalized_mime.startswith("text/")
        or normalized_mime.startswith("image/")
        or normalized_mime.startswith("video/")
    )


def classify_mime(
    detected_mime: str, extension: str, allowed_mimes: set[str] | None = None
) -> MimeClassification:
    allowed = allowed_mimes or ALLOWED_MIME_TYPES
    normalized_mime = _normalize_mime(detected_mime)
    normalized_extension = _normalize_extension(extension)

    if not normalized_mime:
        return MimeClassification.UNKNOWN
    if normalized_mime in AMBIGUOUS_MIME_TYPES:
        return MimeClassification.AMBIGUOUS

    expected = EXTENSION_EXPECTED_MIMES.get(normalized_extension, set())
    if normalized_mime in expected or normalized_mime in allowed:
        return MimeClassification.MATCH
    if _is_confident_mismatch(normalized_mime):
        return MimeClassification.CONFIDENT_MISMATCH
    if normalized_mime.startswith("audio/"):
        return MimeClassification.AMBIGUOUS
    if normalized_mime not in allowed:
        return MimeClassification.CONFIDENT_MISMATCH
    return MimeClassification.AMBIGUOUS


def _default_magic_detector(sample: bytes) -> str:
    try:
        import magic
    except Exception:
        return ""

    try:
        return str(magic.from_buffer(sample, mime=True) or "")
    except Exception:
        return ""


def sniff_mime(
    sample: bytes,
    extension: str,
    file_size: int,
    *,
    detector: Callable[[bytes], str] | None = None,
    allowed_mimes: set[str] | None = None,
) -> MimeSniffResult:
    cache_key = f"{_content_hash_prefix(sample)}:{file_size}"
    cached = _request_cache.get(cache_key)
    if cached is not None:
        return MimeSniffResult(
            classification=cached.classification,
            detected_mime=cached.detected_mime,
            from_cache=True,
        )

    if not sample:
        result = MimeSniffResult(MimeClassification.UNKNOWN, "")
        _request_cache[cache_key] = result
        logger.info("event=UPLOAD_VALIDATION_MIME_FALLBACK reason=empty_sample")
        return result

    detect = detector or _default_magic_detector
    detected_mime = detect(sample[:MAX_SNIFF_BYTES])
    if not detected_mime and detector is None:
        result = MimeSniffResult(MimeClassification.UNKNOWN, "")
        _request_cache[cache_key] = result
        logger.warning(
            "event=UPLOAD_VALIDATION_MIME_FALLBACK reason=library_unavailable"
        )
        return result

    classification = classify_mime(detected_mime, extension, allowed_mimes)
    result = MimeSniffResult(classification, _normalize_mime(detected_mime))

    if classification == MimeClassification.CONFIDENT_MISMATCH:
        logger.warning(
            "event=MIME_MISMATCH detectedMime=%s extension=%s fileSize=%s",
            result.detected_mime,
            extension,
            file_size,
        )
    elif classification in {MimeClassification.AMBIGUOUS, MimeClassification.UNKNOWN}:
        logger.info(
            "event=UPLOAD_VALIDATION_MIME_FALLBACK reason=ambiguous_detected detectedMime=%s extension=%s",
            result.detected_mime,
            extension,
        )
    else:
        logger.info(
            "event=UPLOAD_VALIDATION_MIME_CHECKED detectedMime=%s extension=%s fileSize=%s",
            result.detected_mime,
            extension,
            file_size,
        )

    _request_cache[cache_key] = result
    return result
