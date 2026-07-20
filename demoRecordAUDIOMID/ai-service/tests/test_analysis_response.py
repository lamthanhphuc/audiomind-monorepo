"""Offline AnalysisResponse contract checks (no network / no Gemini)."""

from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.schemas import AnalysisResponse
from app.services.analysis_runs import ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE


def test_scoped_analysis_not_found_requires_created_at():
    with pytest.raises(ValidationError):
        AnalysisResponse(
            meeting_id=8,
            summary="",
            keywords=[],
            technical_terms=[],
            action_items=[],
            status="NOT_FOUND",
            analysisStatus=ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE,
        )


def test_scoped_analysis_not_found_includes_utc_created_at():
    created_at = datetime.now(timezone.utc)
    response = AnalysisResponse(
        meeting_id=8,
        summary="",
        keywords=[],
        technical_terms=[],
        action_items=[],
        status="NOT_FOUND",
        analysisStatus=ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE,
        created_at=created_at,
    )

    assert response.status == "NOT_FOUND"
    assert response.analysisStatus == ANALYSIS_STATUS_UNAVAILABLE_FOR_SCOPE
    assert response.created_at is not None
    assert response.created_at.tzinfo is not None
    assert response.created_at.utcoffset() is not None
