"""Subject membership resolution for Phase 2 study generation guards."""

from __future__ import annotations

import hashlib
import json
from typing import Any

import httpx
from loguru import logger

from app.config import get_settings
from app.services.study import StudyTransientError, StudyValidationError
from app.services.study.exceptions import classify_provider_exception


class MeetingMembershipUnavailableError(Exception):
    """Meeting-service base URL / token not configured (unit-test / local fallback)."""


_MEMBERSHIP_UNAVAILABLE = "MEETING_MEMBERSHIP_SERVICE_UNAVAILABLE"


def hash_membership(meeting_ids: list[int] | None) -> str:
    """SHA256 of sorted unique meeting ids — secondary membership fingerprint."""
    normalized = sorted({int(m) for m in (meeting_ids or [])})
    raw = json.dumps(normalized, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def fetch_subject_meeting_ids(subject_id: int, owner_user_id: int) -> list[int]:
    """Fetch current subject membership from meeting-service.

    Calls the authenticated internal endpoint only:
    ``GET /internal/subjects/{subjectId}/meetings?page=&pageSize=``
    with ``X-Internal-Service-Token`` and ``X-Owner-User-Id``.

    Monkeypatch this function in unit tests when meeting-service is unavailable.
    """
    settings = get_settings()
    base = (
        getattr(settings, "meeting_service_base_url", None)
        or getattr(settings, "meeting_api_base_url", None)
        or ""
    )
    base = str(base).rstrip("/")
    token = (getattr(settings, "internal_service_token", "") or "").strip()
    if not base or not token:
        raise MeetingMembershipUnavailableError(
            "MEETING_SERVICE_BASE_URL / INTERNAL_SERVICE_TOKEN not configured"
        )

    headers = {
        "X-Internal-Service-Token": token,
        "X-Owner-User-Id": str(int(owner_user_id)),
        "Accept": "application/json",
    }
    all_ids: list[int] = []
    seen: set[int] = set()
    page = 1
    page_size = 100
    timeout = float(getattr(settings, "meeting_service_timeout_seconds", 10.0) or 10.0)

    try:
        with httpx.Client(timeout=timeout) as client:
            while page <= 500:
                url = (
                    f"{base}/internal/subjects/{int(subject_id)}/meetings"
                    f"?page={page}&pageSize={page_size}"
                )
                response = client.get(url, headers=headers)
                status = response.status_code

                if status >= 500:
                    raise StudyTransientError(
                        f"meeting-service membership HTTP {status}",
                        code=_MEMBERSHIP_UNAVAILABLE,
                    )
                if status in (401, 403):
                    # Auth/token failure between services is retryable (rotation / misconfig).
                    raise StudyTransientError(
                        f"meeting-service membership HTTP {status}",
                        code=_MEMBERSHIP_UNAVAILABLE,
                    )
                if status == 404:
                    raise StudyValidationError(
                        "SUBJECT_NOT_FOUND",
                        f"Subject {subject_id} not found for owner",
                    )
                if status >= 400:
                    raise StudyValidationError(
                        "MEETING_MEMBERSHIP_REJECTED",
                        f"meeting-service membership HTTP {status}",
                    )

                payload = response.json()
                body = payload if isinstance(payload, dict) else {}
                items = _extract_items(body)
                if not items:
                    break

                for item in items:
                    mid = _extract_meeting_id(item)
                    if mid is None or mid in seen:
                        continue
                    seen.add(mid)
                    all_ids.append(mid)

                total_pages = body.get("totalPages")
                try:
                    pages = int(total_pages) if total_pages is not None else page
                except (TypeError, ValueError):
                    pages = page
                if page >= pages:
                    break
                if len(items) < page_size and total_pages is None:
                    break
                page += 1
    except (
        StudyTransientError,
        StudyValidationError,
        MeetingMembershipUnavailableError,
    ):
        raise
    except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
        logger.warning(
            "event=STUDY_MEMBERSHIP_FETCH_TRANSIENT subjectId={} ownerUserId={} err={}",
            subject_id,
            owner_user_id,
            exc,
        )
        raise StudyTransientError(
            f"meeting-service membership transient: {exc}",
            code=_MEMBERSHIP_UNAVAILABLE,
        ) from exc
    except Exception as exc:  # noqa: BLE001
        classified = classify_provider_exception(exc)
        logger.warning(
            "event=STUDY_MEMBERSHIP_FETCH_FAILED subjectId={} ownerUserId={} err={}",
            subject_id,
            owner_user_id,
            exc,
        )
        if isinstance(classified, StudyTransientError):
            raise StudyTransientError(
                f"meeting-service membership failed: {exc}",
                code=_MEMBERSHIP_UNAVAILABLE,
            ) from exc
        raise classified from exc

    return all_ids


def _extract_items(body: dict[str, Any]) -> list[Any]:
    for key in ("items", "content", "meetings"):
        value = body.get(key)
        if isinstance(value, list):
            return value
    return []


def _extract_meeting_id(item: Any) -> int | None:
    if isinstance(item, dict):
        for key in ("meetingId", "id", "meeting_id"):
            if key in item and item[key] is not None:
                try:
                    return int(item[key])
                except (TypeError, ValueError):
                    return None
    try:
        return int(item)
    except (TypeError, ValueError):
        return None
