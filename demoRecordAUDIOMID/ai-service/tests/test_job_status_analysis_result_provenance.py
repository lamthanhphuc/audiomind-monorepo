from app.job_status_store import build_completed_analysis_job_result


def test_build_completed_analysis_job_result_preserves_existing_provenance(monkeypatch):
    monkeypatch.setattr(
        "app.job_status_store.get_job_status",
        lambda meeting_id: {
            "status": "COMPLETED",
            "result": {
                "domainMode": "education",
                "recording_session_id": 1,
                "attempt_id": 1,
                "transcripts": [{"text": "keep me"}],
            },
        },
    )

    result = build_completed_analysis_job_result(
        meeting_id=88,
        analysis={
            "summary": "Education lesson",
            "domainMode": "education",
            "educationStudy": {"title": "Pythagoras"},
            "promptVersion": "education-analysis-v1",
            "schemaVersion": "education-study-v1",
            "analysisFeatureSet": "education-study-v1",
        },
        source="realtime",
        domain_mode="education",
        recording_session_id=1,
        attempt_id=1,
    )

    assert result["domainMode"] == "education"
    assert result["domain_mode"] == "education"
    assert result["recording_session_id"] == 1
    assert result["attempt_id"] == 1
    assert result["transcripts"] == [{"text": "keep me"}]
    assert result["analysis"]["educationStudy"]["title"] == "Pythagoras"
    assert result["analysis"]["recordingSessionId"] == 1
    assert result["analysis"]["attemptId"] == 1
    assert result["source"] == "realtime"


def test_build_completed_analysis_job_result_restores_domain_when_existing_result_wiped(
    monkeypatch,
):
    monkeypatch.setattr(
        "app.job_status_store.get_job_status",
        lambda meeting_id: {
            "status": "COMPLETED",
            "result": {"source": "realtime"},
        },
    )

    result = build_completed_analysis_job_result(
        meeting_id=89,
        analysis={
            "summary": "Education lesson",
            "domainMode": "education",
            "educationStudy": {"title": "Fresh"},
        },
        source="realtime",
        domain_mode="education",
        recording_session_id=2,
        attempt_id=3,
    )

    assert result["domainMode"] == "education"
    assert result["recording_session_id"] == 2
    assert result["attempt_id"] == 3
    assert result["analysis"]["domainMode"] == "education"
