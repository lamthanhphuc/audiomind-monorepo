#!/usr/bin/env python3
"""Build a URL-encoded PostgreSQL URL for AI service (AI_DATABASE_URL).

Does not print the raw password anywhere (URL output aside, since the URL is
the point of this tool) and never uses shell `source`/`eval` semantics — it is
pure Python argument/env-file parsing.

Preferred usage (reads POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB from a
Docker Compose env-file using the same parser as load-compose-env.py):

  python3 scripts/generate-vps-db-url.py --env-file infra/.env

Host defaults to "db" (the service name in the layered compose stack:
infra/docker-compose.dev.yml + mvp.yml + prod.yml). Override with --host if
your environment still names the service "postgres".

CLI flags remain supported and take precedence over env-file values:

  python3 scripts/generate-vps-db-url.py \\
    --user audiomind --password 'p@ss:word/#' \\
    --host db --port 5432 --database audiomind
"""

from __future__ import annotations

import argparse
import getpass
import importlib.util
import sys
from pathlib import Path
from urllib.parse import quote

_SCRIPT_DIR = Path(__file__).resolve().parent


def _load_env_parser():
    """Import parse_env_file from load-compose-env.py (hyphenated filename)."""
    spec = importlib.util.spec_from_file_location(
        "load_compose_env", _SCRIPT_DIR / "load-compose-env.py"
    )
    if spec is None or spec.loader is None:
        print("ERROR: unable to load scripts/load-compose-env.py", file=sys.stderr)
        raise SystemExit(1)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.parse_env_file


def _error(code: str, message: str) -> "SystemExit":
    print(f"ERROR: {code}: {message}", file=sys.stderr)
    return SystemExit(1)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--env-file",
        type=Path,
        default=None,
        help="Docker Compose env-file to read POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB from",
    )
    parser.add_argument("--user", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--host", default=None, help="default: db (layered compose service name)")
    parser.add_argument("--port", type=int, default=5432)
    parser.add_argument("--database", default=None)
    parser.add_argument(
        "--scheme",
        default="postgresql",
        choices=("postgresql", "postgresql+psycopg2"),
    )
    args = parser.parse_args()

    env_data: dict[str, str] = {}
    if args.env_file is not None:
        if not args.env_file.is_file():
            raise _error("ENV_FILE_MISSING", f"missing env file {args.env_file}")
        parse_env_file = _load_env_parser()
        env_data = parse_env_file(args.env_file)

    user = args.user
    if user is None and args.env_file is not None:
        user = env_data.get("POSTGRES_USER")
    if not user or not user.strip():
        raise _error(
            "POSTGRES_USER_MISSING",
            "set POSTGRES_USER in the env-file or pass --user",
        )

    password = args.password
    if password is None and args.env_file is not None:
        password = env_data.get("POSTGRES_PASSWORD")
    if not password and sys.stdin.isatty():
        password = getpass.getpass("Postgres password (not echoed): ")
    if not password:
        raise _error(
            "POSTGRES_PASSWORD_MISSING",
            "set POSTGRES_PASSWORD in the env-file or pass --password",
        )

    if args.database is not None:
        database = args.database
    elif args.env_file is not None:
        database = env_data.get("POSTGRES_DB")
        if not database or not database.strip():
            raise _error(
                "POSTGRES_DB_MISSING",
                "set POSTGRES_DB in the env-file or pass --database",
            )
    else:
        database = "audiomind"

    # Default host is "db" — the private Docker service name in the layered
    # dev+mvp+prod compose stack. Override with --host if needed.
    host = args.host or "db"

    user_enc = quote(user, safe="")
    secret_enc = quote(password, safe="")
    url = f"{args.scheme}://{user_enc}:{secret_enc}@{host}:{args.port}/{database}"

    print(
        "WARNING: Do not paste this URL into shell history, logs, or chat. "
        "Store it only in infra/.env (AI_DATABASE_URL) with restrictive file permissions.",
        file=sys.stderr,
    )
    print(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
