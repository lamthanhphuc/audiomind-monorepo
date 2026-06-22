import pytest
from fastapi import HTTPException

from app.routes.stt_stream import looks_like_webm, validate_stream_chunk
from app.upload_validation_policy import effective_realtime_max_chunk_bytes


def test_effective_realtime_max_chunk_bytes_reads_contract():
    assert effective_realtime_max_chunk_bytes() == 1_048_576


def test_validate_stream_chunk_rejects_oversized_payload_when_enabled():
    oversized = b"\x1a\x45\xdf\xa3" + (b"\x00" * (effective_realtime_max_chunk_bytes() + 1))
    with pytest.raises(HTTPException) as exc_info:
        validate_stream_chunk(oversized, seq=1, is_final=False, enabled=True)
    assert exc_info.value.status_code == 413
    assert exc_info.value.detail == "REALTIME_CHUNK_TOO_LARGE"


def test_validate_stream_chunk_accepts_valid_webm_when_enabled():
    payload = b"\x1a\x45\xdf\xa3\x01"
    validate_stream_chunk(payload, seq=1, is_final=False, enabled=True)


def test_validate_stream_chunk_noop_when_disabled():
    validate_stream_chunk(b"not-webm", seq=0, is_final=False, enabled=False)


def test_looks_like_webm_detects_ebml_header():
    assert looks_like_webm(b"\x1a\x45\xdf\xa3\x00")
    assert not looks_like_webm(b"RIFF")
