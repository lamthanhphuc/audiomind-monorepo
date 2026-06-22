import time

from app.services.mime_sniffer import (
    MimeClassification,
    classify_mime,
    sniff_mime,
)


def _exe_detector(_sample: bytes) -> str:
    return "application/x-msdownload"


def test_classify_exe_renamed_mp3_is_confident_mismatch():
    result = classify_mime("application/x-msdownload", ".mp3")
    assert result == MimeClassification.CONFIDENT_MISMATCH


def test_sniff_uses_request_cache():
    sample = b"MZ\x90\x00"
    first = sniff_mime(sample, ".mp3", len(sample), detector=_exe_detector)
    second = sniff_mime(sample, ".mp3", len(sample), detector=_exe_detector)

    assert first.classification == MimeClassification.CONFIDENT_MISMATCH
    assert second.from_cache is True


def test_sniff_exe_renamed_mp3_integration():
    sample = b"MZ\x90\x00\x03\x00\x00\x00"
    result = sniff_mime(sample, ".mp3", len(sample), detector=_exe_detector)
    assert result.classification == MimeClassification.CONFIDENT_MISMATCH


def test_sniff_perf_under_50ms_for_64k_sample():
    sample = b"ID3" + (b"\x00" * ((64 * 1024) - 3))

    def _mp3_detector(_sample: bytes) -> str:
        return "audio/mpeg"

    started = time.perf_counter()
    sniff_mime(sample, ".mp3", len(sample), detector=_mp3_detector)
    elapsed_ms = (time.perf_counter() - started) * 1000

    assert elapsed_ms < 50, f"sniff latency was {elapsed_ms:.2f}ms"
