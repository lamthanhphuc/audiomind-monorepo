"""Parse audiomind-vps Nginx location precedence for critical path routing."""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
NGINX_CONF = REPO_ROOT / "infra" / "nginx" / "audiomind-vps.conf.example"


def _locations(conf: str) -> list[tuple[str, str]]:
    """Return (matcher, upstream_snippet) in file order."""
    pattern = re.compile(
        r"location\s+(?P<mod>=\s+)?(?P<path>[^\s{]+)\s*\{(?P<body>.*?)\n\s*\}",
        re.DOTALL,
    )
    rows: list[tuple[str, str]] = []
    for match in pattern.finditer(conf):
        exact = bool(match.group("mod"))
        path = match.group("path").strip()
        body = match.group("body")
        kind = f"={path}" if exact else path
        upstream = "frontend" if "audiomind_frontend" in body else (
            "user" if "audiomind_user_api" in body else (
                "meeting" if "audiomind_meeting_api" in body else (
                    "processing" if "audiomind_processing_api" in body else (
                        "ai" if "audiomind_ai_api" in body else "unknown"
                    )
                )
            )
        )
        rows.append((kind, upstream))
    return rows


def _match(path: str, locations: list[tuple[str, str]]) -> str:
    """Approximate nginx longest-prefix + exact match."""
    exact = [row for row in locations if row[0].startswith("=")]
    for kind, upstream in exact:
        if kind == f"={path}":
            return upstream
    prefixes = sorted(
        [row for row in locations if not row[0].startswith("=")],
        key=lambda row: len(row[0]),
        reverse=True,
    )
    for kind, upstream in prefixes:
        if path == kind or path.startswith(kind if kind.endswith("/") else kind + "/") or path.startswith(kind):
            # Prefer true prefix: /subjects matches /subjects and /subjects/1
            if kind == "/" or path == kind or path.startswith(kind.rstrip("/") + "/") or path.startswith(kind):
                return upstream
    return "none"


def test_nginx_critical_routes():
    conf = NGINX_CONF.read_text(encoding="utf-8")
    locations = _locations(conf)
    assert ("=/auth/google/success", "frontend") in locations
    assert ("/users/", "user") in locations

    cases = {
        "/users/me/google/status": "user",
        "/auth/google/success": "frontend",
        "/auth/google/callback": "user",
        "/subjects": "meeting",
        "/processing/subjects/1/synthesis": "processing",
        "/api/config/upload": "meeting",
        "/api/config/lexicon": "ai",
        "/ws/meetings": "processing",
        "/": "frontend",
    }
    for path, expected in cases.items():
        assert _match(path, locations) == expected, f"{path} -> expected {expected}"
