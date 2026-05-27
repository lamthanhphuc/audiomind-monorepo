from __future__ import annotations

import hashlib
import re
from typing import Any


def sanitize_log_value(value: Any, *, max_len: int = 160) -> str:
    text = str(value or "").replace("\n", " ").replace("\r", " ").strip()
    if not text:
        return ""
    lowered = text.lower()
    if any(
        token in lowered
        for token in (
            "authorization",
            "bearer ",
            "api_key",
            "token=",
            "password",
            "secret",
        )
    ):
        return "redacted"
    normalized = re.sub(r"\s+", " ", text)
    if len(normalized) > max_len:
        return normalized[: max_len - 3].rstrip() + "..."
    return normalized


def safe_error_message(error: BaseException | Any) -> str:
    if isinstance(error, BaseException):
        source = f"{error.__class__.__name__}: {error}"
    else:
        source = str(error or "")
    cleaned = sanitize_log_value(source, max_len=180)
    return cleaned or "unexpected error"


def transcript_hash_prefix(transcript: str, length: int = 12) -> str:
    text = str(transcript or "")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return digest[: max(4, min(length, len(digest)))]
