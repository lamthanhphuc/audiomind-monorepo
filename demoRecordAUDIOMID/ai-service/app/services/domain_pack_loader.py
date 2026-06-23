"""Domain pack loader for Epic 3 Slice 3."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path


def _resolve_domain_packs_dir() -> Path:
    explicit = os.getenv("DOMAIN_PACKS_DIR")
    if explicit:
        return Path(explicit)

    here = Path(__file__).resolve()
    for parent in here.parents:
        monorepo = parent / "packages" / "contracts" / "domain-packs"
        if monorepo.is_dir():
            return monorepo
        bundled = parent / "domain-packs"
        if bundled.is_dir():
            return bundled

    return here.parents[1] / "domain-packs"


_DOMAIN_PACKS_DIR = _resolve_domain_packs_dir()


@lru_cache(maxsize=32)
def load_domain_pack(domain: str) -> dict | None:
    normalized = str(domain or "general").strip().lower() or "general"
    pack_path = _DOMAIN_PACKS_DIR / f"{normalized}.json"
    if not pack_path.exists():
        return None
    with pack_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)
