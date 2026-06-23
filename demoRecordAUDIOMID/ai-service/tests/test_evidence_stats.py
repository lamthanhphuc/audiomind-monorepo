"""Tests for evidence_stats IDF computation."""

import math

from app.services.evidence_stats import (
    compute_evidence_stats,
    enrich_rows_with_term_frequency,
)


def test_idf_ln_formula():
    rows = enrich_rows_with_term_frequency(
        [
            {
                "text": "hop dong mot",
                "speaker": "S1",
                "start_time": 0.0,
                "end_time": 1.0,
            },
            {
                "text": "hop dong hai",
                "speaker": "S1",
                "start_time": 1.0,
                "end_time": 2.0,
            },
            {"text": "thanh toan", "speaker": "S1", "start_time": 2.0, "end_time": 3.0},
        ]
    )
    stats = compute_evidence_stats(rows)
    assert stats["segment_count"] == 3
    expected = math.log(3 / 2)
    assert abs(stats["idf"]["hop"] - expected) < 1e-6
    assert abs(stats["idf"]["dong"] - expected) < 1e-6
