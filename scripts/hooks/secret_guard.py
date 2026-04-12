#!/usr/bin/env python3
"""Secret guard: exits with code 1 if secret-like patterns are detected."""

import re
import sys
from pathlib import Path

SECRET_PATTERNS = [
    re.compile(r"(?i)\bpassword\b\s*[:=]\s*\S+"),
    re.compile(r"(?i)\bapi[_-]?key\b\s*[:=]\s*\S+"),
    re.compile(r"(?i)\bsecret\b\s*[:=]\s*\S+"),
    re.compile(r"(?i)\btoken\b\s*[:=]\s*\S+"),
]


def _contains_secret(text: str) -> bool:
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def main() -> int:
    if len(sys.argv) > 1:
        combined = []
        for raw_path in sys.argv[1:]:
            path = Path(raw_path)
            if not path.exists():
                continue
            try:
                combined.append(path.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                continue
        text = "\n".join(combined)
    else:
        text = sys.stdin.read()

    if _contains_secret(text):
        print("secret_guard: secret pattern detected")
        return 1

    print("secret_guard: clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
