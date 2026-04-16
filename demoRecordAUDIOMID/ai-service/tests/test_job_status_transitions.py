import importlib.util
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "app" / "job_status_store.py"
SPEC = importlib.util.spec_from_file_location("job_status_store", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


ALLOWED_CASES = [
    ("UNKNOWN", "QUEUED"),
    ("QUEUED", "RUNNING"),
    ("RUNNING", "COMPLETED"),
    ("RUNNING", "FAILED"),
    ("RETRYING", "RUNNING"),
]

DISALLOWED_CASES = [
    ("COMPLETED", "FAILED"),
    ("FAILED", "COMPLETED"),
    ("FAILED", "RUNNING"),
    ("QUEUED", "QUEUED_INVALID"),
]


def test_allowed_transition_matrix_examples():
    for current, nxt in ALLOWED_CASES:
        assert MODULE._is_allowed_transition(current, nxt)


def test_rejects_terminal_state_overwrite_race_paths():
    for current, nxt in DISALLOWED_CASES:
        assert not MODULE._is_allowed_transition(current, nxt)
