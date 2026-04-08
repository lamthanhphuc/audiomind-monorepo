from datetime import datetime

from fastapi.testclient import TestClient

from app.database import get_db
from app.main import app
import app.main as main_module


class DummyAnalysis:
    def __init__(self):
        self.summary = "Day la summary"
        self.keywords = ["a", "b"]
        self.technical_terms = ["API"]
        self.action_items = [{"task": "Follow up", "owner": None, "deadline": None}]
        self.created_at = datetime.utcnow()


class DummyTranscript:
    def __init__(self):
        self.speaker = "SPEAKER_1"
        self.start_time = 0.0
        self.end_time = 1.0
        self.text = "Xin chao"


class DummyPipeline:
    def process_meeting(self, **kwargs):
        return {"status": "completed"}

    def get_transcript(self, meeting_id, db):
        return [DummyTranscript()]

    def get_analysis(self, meeting_id, db):
        return DummyAnalysis()


def _override_db():
    yield object()


def test_endpoints_async_flow(monkeypatch):
    monkeypatch.setattr(main_module, "pipeline", DummyPipeline())
    app.dependency_overrides[get_db] = _override_db

    client = TestClient(app)

    health = client.get("/health")
    assert health.status_code == 200

    process = client.post(
        "/api/process",
        json={
            "meeting_id": 1001,
            "audio_path": "/app/uploads/test.mp3",
            "language": "vi",
        },
    )
    assert process.status_code == 200
    payload = process.json()
    assert payload["status"] == "queued"

    status = client.get("/api/meeting/1001/status")
    assert status.status_code == 200
    assert status.json()["status"] in {"QUEUED", "RUNNING", "COMPLETED"}

    transcript = client.get("/api/meeting/1001/transcript")
    assert transcript.status_code == 200
    assert len(transcript.json()["transcripts"]) == 1

    analysis = client.get("/api/meeting/1001/analysis")
    assert analysis.status_code == 200
    assert analysis.json()["summary"] == "Day la summary"

    app.dependency_overrides.clear()
