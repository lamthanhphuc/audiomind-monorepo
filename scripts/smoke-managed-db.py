#!/usr/bin/env python3
"""Managed PostgreSQL schema smoke for user/meeting/AI databases.

Reads MEETING_DATABASE_URL, USER_DATABASE_URL, AI_DATABASE_URL (or DATABASE_URL)
plus optional DB_USERNAME / DB_PASSWORD. Never logs credentials.
"""

from __future__ import annotations

import os
import sys
from urllib.parse import unquote, urlparse

try:
    import psycopg2
except ImportError:  # pragma: no cover
    print("FAIL smoke-managed-db: psycopg2 not installed", file=sys.stderr)
    sys.exit(1)

AI_ALEMBIC_HEAD = "015"

USER_CHECKS = (
    ("flyway_schema_history_user", "SELECT to_regclass('public.flyway_schema_history_user')"),
    ("app_users", "SELECT to_regclass('public.app_users')"),
    ("quota_consumption", "SELECT to_regclass('public.quota_consumption')"),
)

MEETING_CHECKS = (
    ("flyway_schema_history_meeting", "SELECT to_regclass('public.flyway_schema_history_meeting')"),
    ("meeting", "SELECT to_regclass('public.meeting')"),
    ("study_folder", "SELECT to_regclass('public.study_folder')"),
    ("subject", "SELECT to_regclass('public.subject')"),
    ("meeting.subject_id", """
        SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='meeting' AND column_name='subject_id'
    """),
)

AI_CHECKS = (
    ("alembic_version", "SELECT version_num FROM alembic_version LIMIT 1"),
    ("subject_synthesis", "SELECT to_regclass('public.subject_synthesis')"),
    ("study_artifact", "SELECT to_regclass('public.study_artifact')"),
)


def _fail(message: str) -> None:
    print(f"FAIL smoke-managed-db: {message}", file=sys.stderr)
    sys.exit(1)


def _jdbc_to_psycopg2(url: str, username: str | None, password: str | None) -> str:
    raw = url.strip()
    if raw.startswith("jdbc:"):
        raw = raw[5:]
    if not raw.startswith("postgresql://"):
        _fail(f"unsupported JDBC/DSN scheme: {url[:32]}...")
    parsed = urlparse(raw)
    user = unquote(parsed.username or "") or (username or "")
    password_val = unquote(parsed.password or "") if parsed.password else (password or "")
    host = parsed.hostname or ""
    port = parsed.port or 5432
    dbname = (parsed.path or "/").lstrip("/").split("?", 1)[0]
    if not host or not dbname:
        _fail("could not parse database host/dbname from URL")
    auth = ""
    if user:
        auth = user
        if password_val:
            auth += f":{password_val}"
        auth += "@"
    query = parsed.query
    return f"postgresql://{auth}{host}:{port}/{dbname}" + (f"?{query}" if query else "")


def _resolve_dsn(env_name: str) -> str:
    url = os.environ.get(env_name) or os.environ.get("DATABASE_URL")
    if not url:
        _fail(f"missing {env_name} (or DATABASE_URL)")
    username = os.environ.get("DB_USERNAME")
    password = os.environ.get("DB_PASSWORD")
    if url.startswith("jdbc:postgresql://") or url.startswith("postgresql://"):
        return _jdbc_to_psycopg2(url, username, password)
    if url.startswith("postgresql+psycopg2://"):
        return "postgresql://" + url.split("://", 1)[1]
    _fail(f"{env_name} must be jdbc:postgresql:// or postgresql://")
    raise AssertionError


def _connect(dsn: str):
    try:
        return psycopg2.connect(dsn)
    except psycopg2.Error as exc:
        _fail(f"connection failed: {exc.__class__.__name__}")


def _scalar(conn, sql: str):
    with conn.cursor() as cur:
        cur.execute(sql)
        row = cur.fetchone()
        return row[0] if row else None


def _check_group(label: str, dsn: str, checks: tuple[tuple[str, str], ...]) -> None:
    conn = _connect(dsn)
    try:
        for name, sql in checks:
            value = _scalar(conn, sql)
            if name == "alembic_version":
                if str(value) != AI_ALEMBIC_HEAD:
                    _fail(f"AI alembic_version={value!r}, expected {AI_ALEMBIC_HEAD}")
                print(f"  OK {label}: alembic_version={value}")
                continue
            if name.endswith(".subject_id"):
                if not value or int(value) < 1:
                    _fail(f"{label} missing meeting.subject_id column")
                print(f"  OK {label}: meeting.subject_id column present")
                continue
            if not value:
                _fail(f"{label} missing {name}")
            print(f"  OK {label}: {name}")
    finally:
        conn.close()


def main() -> int:
    print("smoke-managed-db: connecting (credentials not logged)")
    user_dsn = _resolve_dsn("USER_DATABASE_URL")
    meeting_dsn = _resolve_dsn("MEETING_DATABASE_URL")
    ai_dsn = _resolve_dsn("AI_DATABASE_URL")

    print("User DB:")
    _check_group("user", user_dsn, USER_CHECKS)
    print("Meeting DB:")
    _check_group("meeting", meeting_dsn, MEETING_CHECKS)
    print("AI DB:")
    _check_group("ai", ai_dsn, AI_CHECKS)

    print("PASS smoke-managed-db")
    return 0


if __name__ == "__main__":
    sys.exit(main())
