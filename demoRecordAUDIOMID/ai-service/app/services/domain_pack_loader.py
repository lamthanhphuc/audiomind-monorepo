"""Domain pack loader for Epic 3 Slice 3."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_DOMAIN_PACKS_DIR = (
    Path(__file__).resolve().parents[4] / "packages" / "contracts" / "domain-packs"
)


@lru_cache(maxsize=32)
def load_domain_pack(domain: str) -> dict | None:
    normalized = str(domain or "general").strip().lower() or "general"
    pack_path = _DOMAIN_PACKS_DIR / f"{normalized}.json"
    if not pack_path.exists():
        return None
    with pack_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)
