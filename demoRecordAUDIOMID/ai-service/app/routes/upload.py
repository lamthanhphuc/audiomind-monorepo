from fastapi import HTTPException

from app.services.mime_sniffer import MimeClassification, sniff_mime


def validate_upload_mime(
    sample: bytes,
    extension: str,
    file_size: int,
    *,
    enabled: bool,
) -> None:
    if not enabled:
        return

    result = sniff_mime(sample, extension, file_size)
    if result.classification == MimeClassification.CONFIDENT_MISMATCH:
        raise HTTPException(status_code=415, detail="UPLOAD_MIME_MISMATCH")
