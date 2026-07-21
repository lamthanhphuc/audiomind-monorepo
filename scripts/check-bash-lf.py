#!/usr/bin/env python3
"""Fail when any tracked *.sh / *.bash file contains CRLF line endings."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _shell_scripts() -> list[Path]:
    patterns = ("*.sh", "*.bash")
    found: list[Path] = []
    for pattern in patterns:
        found.extend(ROOT.rglob(pattern))
    return sorted({p.resolve() for p in found if p.is_file()})


def main() -> int:
    offenders: list[str] = []
    for path in _shell_scripts():
        if b"\r\n" in path.read_bytes():
            offenders.append(str(path.relative_to(ROOT)))

    if offenders:
        print("FAIL: CRLF detected in shell scripts (expected LF only):")
        for item in offenders:
            print(f"  {item}")
        return 1

    print(f"PASS: {len(_shell_scripts())} shell scripts use LF line endings")
    return 0


if __name__ == "__main__":
    sys.exit(main())
