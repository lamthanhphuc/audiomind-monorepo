#!/usr/bin/env python3
"""Build a URL-encoded PostgreSQL URL for AI service (AI_DATABASE_URL).

Does not echo the raw password. Prefer pasting the printed URL into
.env.production manually; avoid shell history if possible.

Example:
  python3 scripts/generate-vps-db-url.py \\
    --user audiomind --password 'p@ss:word/#' \\
    --host postgres --port 5432 --database audiomind
"""

from __future__ import annotations

import argparse
import getpass
import sys
from urllib.parse import quote


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", required=True)
    parser.add_argument("--password", default="")
    parser.add_argument("--host", default="postgres")
    parser.add_argument("--port", type=int, default=5432)
    parser.add_argument("--database", default="audiomind")
    parser.add_argument(
        "--scheme",
        default="postgresql",
        choices=("postgresql", "postgresql+psycopg2"),
    )
    args = parser.parse_args()

    password = args.password
    if not password:
        password = getpass.getpass("Postgres password (not echoed): ")

    if not password:
        print("ERROR: empty password", file=sys.stderr)
        return 1

    user = quote(args.user, safe="")
    secret = quote(password, safe="")
    url = (
        f"{args.scheme}://{user}:{secret}@{args.host}:{args.port}/{args.database}"
    )
    print(
        "WARNING: Do not paste this URL into shell history logs or chat. "
        "Store it only in .env.production with mode 600.",
        file=sys.stderr,
    )
    print(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
