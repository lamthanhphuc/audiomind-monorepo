import app.tasks as tasks


class DummyDB:
    def close(self):
        return None


class DummySnapshot:
    def __init__(self):
        self.terms = ["API", "Docker"]
        self.topic_defaults = {"engineering": ["API"]}
        self.normalization_map = {r"\\bapi\\b": "API"}
        self.version_hash = "snapshot-hash"
        self.version_id = 42


class DummyGlossaryService:
    def __init__(self, repository, cache_ttl_seconds=300):
        self.repository = repository
        self.cache_ttl_seconds = cache_ttl_seconds

    def resolve_domain_for_version(self, version_id):
        return "engineering" if version_id == 42 else None

    def get_snapshot(self, domain=None):
        return DummySnapshot()


class DummyPipeline:
    def __init__(self):
        self.calls = []

    def process_meeting(self, **kwargs):
        self.calls.append(kwargs)

    def get_transcript(self, meeting_id, db):
        return []

    def get_analysis(self, meeting_id, db):
        return None


def test_process_meeting_resolves_glossary_ref(monkeypatch):
    dummy_db = DummyDB()
    dummy_pipeline = DummyPipeline()
    statuses = []

    class FakeSessionLocal:
        def __call__(self):
            return dummy_db

    def fake_set_job_status(meeting_id, status, **kwargs):
        statuses.append((meeting_id, status, kwargs))

    monkeypatch.setattr(tasks, "SessionLocal", FakeSessionLocal())
    monkeypatch.setattr(tasks, "pipeline", dummy_pipeline)
    monkeypatch.setattr(tasks, "set_job_status", fake_set_job_status)
    monkeypatch.setattr(tasks, "GlossaryService", DummyGlossaryService)

    tasks.process_meeting(
        {
            "meeting_id": 77,
            "audio_path": "/app/uploads/sample.wav",
            "glossary_ref": {
                "glossary_id": 42,
                "domain": "engineering",
                "version_hash": "request-hash",
            },
        }
    )

    assert statuses[0][1] == "RUNNING"
    assert dummy_pipeline.calls[0]["glossary_context"]["domain"] == "engineering"
    assert dummy_pipeline.calls[0]["glossary_context"]["version_id"] == 42
    assert dummy_pipeline.calls[0]["glossary_context"]["version_hash"] == "request-hash"


def test_process_meeting_resolves_glossary_context_from_topic(monkeypatch):
    dummy_db = DummyDB()
    dummy_pipeline = DummyPipeline()

    class FakeSessionLocal:
        def __call__(self):
            return dummy_db

    monkeypatch.setattr(tasks, "SessionLocal", FakeSessionLocal())
    monkeypatch.setattr(tasks, "pipeline", dummy_pipeline)
    monkeypatch.setattr(tasks, "set_job_status", lambda *args, **kwargs: None)
    monkeypatch.setattr(tasks, "GlossaryService", DummyGlossaryService)

    tasks.process_meeting(
        {
            "meeting_id": 88,
            "audio_path": "/app/uploads/sample.wav",
            "topic": "engineering",
        }
    )

    assert dummy_pipeline.calls[0]["glossary_context"]["domain"] == "engineering"
    assert dummy_pipeline.calls[0]["glossary_context"]["normalization_map"] == {
        r"\\bapi\\b": "API"
    }
