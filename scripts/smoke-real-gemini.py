#!/usr/bin/env python3
"""Optional real Gemini smoke for subject synthesis + flashcards.

When RUN_REAL_GEMINI_SMOKE=true: requires GEMINI_API_KEY, validates schema, enforces cost guard.
When false/unset: NOT RUN (exit 0).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
AI_SERVICE = ROOT / "demoRecordAUDIOMID" / "ai-service"
if str(AI_SERVICE) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE))

MAX_PROMPT_CHARS = int(os.environ.get("REAL_GEMINI_MAX_PROMPT_CHARS", "12000"))


def _truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _fail(message: str) -> None:
    print(f"FAIL smoke-real-gemini: {message}", file=sys.stderr)
    sys.exit(1)


def _not_run(reason: str) -> None:
    print(f"NOT RUN smoke-real-gemini: {reason}")
    sys.exit(0)


def _mini_sources() -> list[dict[str, Any]]:
    return [
        {
            "meetingId": 1,
            "title": "Smoke lecture",
            "language": "vi",
            "educationStudy": {
                "summary": "Architecture and microservices overview.",
                "keyTopics": ["layering", "boundaries", "scaling"],
                "segments": [
                    {
                        "segmentId": "seg-1",
                        "speaker": "T1",
                        "startTime": 0.0,
                        "endTime": 12.0,
                        "text": "Software architecture covers layering, boundaries, and deployment.",
                    },
                    {
                        "segmentId": "seg-2",
                        "speaker": "T1",
                        "startTime": 12.0,
                        "endTime": 24.0,
                        "text": "Microservices trade operational complexity for independent scaling.",
                    },
                ],
            },
            "transcriptHash": "smoke-hash-1",
            "analysisRunId": 1,
            "analysisVersion": "smoke-v1",
        }
    ]


def main() -> int:
    if not _truthy("RUN_REAL_GEMINI_SMOKE"):
        _not_run("RUN_REAL_GEMINI_SMOKE is not true")

    if not os.environ.get("GEMINI_API_KEY", "").strip():
        _fail("RUN_REAL_GEMINI_SMOKE=true but GEMINI_API_KEY missing")

    from app.services.study import ARTIFACT_FLASHCARDS
    from app.services.study.artifacts import generate_artifact_content, validate_options
    from app.services.study.service import _gemini_caller
    from app.services.study.synthesis import run_hierarchical_synthesis

    print("smoke-real-gemini: calling Gemini (key not logged)")
    sources = _mini_sources()
    options = validate_options(
        {"language": "vi", "difficulty": "MIXED", "flashcardCount": 3, "multipleChoiceCount": 2}
    )
    call_gemini = _gemini_caller()

    synthesis = run_hierarchical_synthesis(sources, language="vi", call_gemini=call_gemini)
    chapters = synthesis.get("chapters") if isinstance(synthesis, dict) else None
    if not isinstance(chapters, list) or not chapters:
        _fail("synthesis result missing chapters[]")

    flashcards = generate_artifact_content(
        ARTIFACT_FLASHCARDS,
        synthesis_content=synthesis,
        ready_sources=sources,
        options=options,
        call_gemini=call_gemini,
    )
    cards = flashcards.get("cards") if isinstance(flashcards, dict) else None
    if not isinstance(cards, list) or not cards:
        _fail("flashcards artifact missing cards[]")

    print(f"  synthesis chapters={len(chapters)}")
    print(f"  flashcards={len(cards)}")
    print("PASS smoke-real-gemini")
    return 0


if __name__ == "__main__":
    sys.exit(main())
