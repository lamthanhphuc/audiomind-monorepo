from __future__ import annotations

from fastapi import HTTPException
from loguru import logger

from app.upload_validation_policy import effective_realtime_max_chunk_bytes

WEBM_EBML_HEADER = bytes((0x1A, 0x45, 0xDF, 0xA3))


def looks_like_webm(payload: bytes) -> bool:
    return len(payload) >= 4 and payload[:4] == WEBM_EBML_HEADER


def validate_stream_chunk(
    chunk_bytes: bytes,
    *,
    seq: int,
    is_final: bool,
    enabled: bool,
) -> None:
    if not enabled:
        return

    max_chunk_bytes = effective_realtime_max_chunk_bytes()
    if seq < 1:
        logger.warning(
            "event=REALTIME_VALIDATION_FAILED errorCode=REALTIME_INVALID_PAYLOAD seq={}",
            seq,
        )
        raise HTTPException(status_code=400, detail="REALTIME_INVALID_PAYLOAD")

    if len(chunk_bytes) > max_chunk_bytes:
        logger.warning(
            "event=REALTIME_CHUNK_TOO_LARGE byteLength={} maxChunkBytes={} seq={}",
            len(chunk_bytes),
            max_chunk_bytes,
            seq,
        )
        raise HTTPException(status_code=413, detail="REALTIME_CHUNK_TOO_LARGE")

    if len(chunk_bytes) == 0 and not is_final:
        logger.warning(
            "event=REALTIME_VALIDATION_FAILED errorCode=REALTIME_INVALID_PAYLOAD seq={} reason=empty_chunk",
            seq,
        )
        raise HTTPException(status_code=400, detail="REALTIME_INVALID_PAYLOAD")

    if len(chunk_bytes) > 0 and not looks_like_webm(chunk_bytes):
        logger.warning(
            "event=REALTIME_UNSUPPORTED_ENCODING byteLength={} seq={}",
            len(chunk_bytes),
            seq,
        )
        raise HTTPException(status_code=415, detail="REALTIME_UNSUPPORTED_ENCODING")

    logger.info(
        "event=REALTIME_VALIDATION_ACCEPTED byteLength={} seq={} isFinal={}",
        len(chunk_bytes),
        seq,
        is_final,
    )
