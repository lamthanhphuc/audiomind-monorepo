"""Regression: Alembic/Flyway source must cover revisions already applied in DB."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AI_VERSIONS = ROOT / "demoRecordAUDIOMID" / "ai-service" / "alembic" / "versions"
USER_MIG = ROOT / "demoRecordAUDIOMID" / "user-service" / "src" / "main" / "resources" / "db" / "migration"
MEETING_MIG = (
    ROOT / "demoRecordAUDIOMID" / "meeting-service" / "src" / "main" / "resources" / "db" / "migration"
)
AI_DOCKERFILE = ROOT / "infra" / "docker" / "flyway" / "ai" / "Dockerfile"
USER_DOCKERFILE = ROOT / "infra" / "docker" / "flyway" / "user" / "Dockerfile"
MEETING_DOCKERFILE = ROOT / "infra" / "docker" / "flyway" / "meeting" / "Dockerfile"


def _alembic_graph() -> tuple[dict[str, str | None], list[str]]:
    revs: dict[str, str | None] = {}
    downs: set[str] = set()
    for path in AI_VERSIONS.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        rev_m = re.search(r"^revision\s*[:=]\s*['\"]([^'\"]+)['\"]", text, re.M)
        down_m = re.search(r"^down_revision\s*[:=]\s*([^\n]+)", text, re.M)
        if not rev_m:
            continue
        rev = rev_m.group(1)
        down_raw = (down_m.group(1) if down_m else "None").strip()
        if down_raw in {"None", "none"}:
            down = None
        else:
            down = down_raw.strip("'\"")
        revs[rev] = down
        if down:
            downs.add(down)
    heads = [r for r in revs if r not in downs]
    return revs, heads


def test_alembic_revision_015_present():
    matches = list(AI_VERSIONS.glob("*015*.py"))
    assert matches, "Alembic revision 015 missing from source"
    text = matches[0].read_text(encoding="utf-8")
    assert re.search(r"^revision\s*=\s*['\"]015['\"]", text, re.M)


def test_alembic_single_head():
    revs, heads = _alembic_graph()
    assert revs, "no Alembic revisions found"
    assert len(heads) == 1, f"expected one Alembic head, got {heads}"
    assert heads[0] == "015"


def test_user_flyway_v11_present():
    matches = list(USER_MIG.glob("V11__*.sql"))
    assert matches, "User Flyway V11 missing from source"


def test_meeting_flyway_through_v16():
    versions = sorted(
        int(m.group(1))
        for p in MEETING_MIG.glob("V*__*.sql")
        if (m := re.match(r"V(\d+)__", p.name))
    )
    assert versions, "Meeting Flyway migrations missing"
    assert max(versions) >= 16, f"Meeting Flyway latest is V{max(versions)}, need >= V16"
    for expected in range(1, max(versions) + 1):
        assert expected in versions, f"Meeting Flyway missing V{expected}"


def test_migration_dockerfiles_copy_sources():
    assert "demoRecordAUDIOMID/ai-service" in AI_DOCKERFILE.read_text(encoding="utf-8")
    assert "user-service/src/main/resources/db/migration" in USER_DOCKERFILE.read_text(
        encoding="utf-8"
    )
    assert "meeting-service/src/main/resources/db/migration" in MEETING_DOCKERFILE.read_text(
        encoding="utf-8"
    )
