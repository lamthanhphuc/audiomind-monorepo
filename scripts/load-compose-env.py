#!/usr/bin/env python3
"""Parse a Docker Compose env-file safely (no shell expansion / no eval).

Usage:
  eval "$(python3 scripts/load-compose-env.py --file .env.production --export-shell)"

Or print KEY=VALUE lines for bash `while read`:
  python3 scripts/load-compose-env.py --file .env.production --print-exports

Values with $, #, spaces, quotes, @, : are preserved literally.
"""

from __future__ import annotations

import argparse
import re
import shlex
import sys
from pathlib import Path

_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_env_file(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    text = path.read_text(encoding="utf-8")
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not _KEY_RE.match(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        result[key] = value
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument(
        "--require",
        action="append",
        default=[],
        help="Fail if KEY is missing (repeatable)",
    )
    parser.add_argument(
        "--print-exports",
        action="store_true",
        help="Print bash-safe KEY=VALUE assignments (no export keyword)",
    )
    parser.add_argument(
        "--export-shell",
        action="store_true",
        help="Print `export KEY=...` lines for eval",
    )
    parser.add_argument(
        "--get",
        action="append",
        default=[],
        help="Print one value for KEY to stdout (repeatable prints lines)",
    )
    args = parser.parse_args()

    if not args.file.is_file():
        print(f"ERROR: missing env file {args.file}", file=sys.stderr)
        return 1

    data = parse_env_file(args.file)
    for key in args.require:
        if key not in data or not str(data[key]).strip():
            print(f"ERROR: required key missing: {key}", file=sys.stderr)
            return 1

    if args.get:
        for key in args.get:
            if key not in data:
                print(f"ERROR: missing key {key}", file=sys.stderr)
                return 1
            sys.stdout.write(data[key] + ("\n" if len(args.get) > 1 else ""))
        return 0

    if args.export_shell:
        for key, value in data.items():
            sys.stdout.write(f"export {key}={shlex.quote(value)}\n")
        return 0

    if args.print_exports:
        for key, value in data.items():
            sys.stdout.write(f"{key}={shlex.quote(value)}\n")
        return 0

    # Default: JSON-ish key list for validation tooling
    for key in sorted(data):
        sys.stdout.write(f"{key}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
