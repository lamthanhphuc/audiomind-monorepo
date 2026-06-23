"""Evidence stats computation for canonical persist (Epic 3 §5.4)."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from app.services.tokenizer import term_frequency_map
from app.services.transcript_canonicalizer import CANONICAL_VERSION


def enrich_rows_with_term_frequency(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    enriched: list[dict[str, Any]] = []
    for row in rows:
        copy = dict(row)
        copy["term_frequency"] = term_frequency_map(str(copy.get("text") or ""))
        enriched.append(copy)
    return enriched


def compute_evidence_stats(
    rows: list[dict[str, Any]], *, version: str = CANONICAL_VERSION
) -> dict[str, Any]:
    total_segments = len(rows)
    doc_freq: dict[str, int] = {}
    for row in rows:
        tf_map = row.get("term_frequency") or {}
        if not isinstance(tf_map, dict):
            continue
        for term in tf_map:
            doc_freq[term] = doc_freq.get(term, 0) + 1

    idf: dict[str, float] = {}
    for term, containing in doc_freq.items():
        idf[term] = math.log(total_segments / max(1, containing))

    return {
        "idf": idf,
        "segment_count": total_segments,
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "canonical_version": version,
    }
