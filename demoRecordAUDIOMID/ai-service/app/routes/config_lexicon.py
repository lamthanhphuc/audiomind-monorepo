"""Lexicon config endpoint (Epic 3 Slice 3)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from loguru import logger
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.services.domain_pack_loader import load_domain_pack
from app.services.glossary_repository import GlossaryRepository
from app.services.glossary_service import GlossaryService

router = APIRouter(prefix="/api/config", tags=["config"])
settings = get_settings()


@router.get("/lexicon")
def get_lexicon(domain: str = Query(default="general"), db: Session = Depends(get_db)):
    service = GlossaryService(
        GlossaryRepository(db), cache_ttl_seconds=settings.glossary_cache_ttl_seconds
    )
    db_resolution = service.resolve(domain)
    pack = load_domain_pack(domain) if settings.domain_lexicon_enabled else None

    terms: dict[str, dict] = {}
    normalization_map: dict[str, str] = dict(db_resolution.normalization_map or {})

    for term in db_resolution.terms or []:
        key = str(term).strip().lower()
        if key:
            terms[key] = {"term": term, "source": "db"}

    if pack:
        for entry in pack.get("terms") or []:
            if not isinstance(entry, dict):
                continue
            normalized = (
                str(entry.get("normalized") or entry.get("term") or "").strip().lower()
            )
            if not normalized:
                continue
            if normalized in terms:
                logger.info(
                    "event=DOMAIN_LEXICON_COLLISION term={} packSource={} dbSource={} domain={}",
                    normalized,
                    pack.get("domain"),
                    terms[normalized].get("source"),
                    domain,
                )
            terms[normalized] = {
                "term": entry.get("term"),
                "normalized": normalized,
                "category": entry.get("category"),
                "source": "pack",
            }
        for key, value in (pack.get("normalizationMap") or {}).items():
            normalization_map[str(key)] = str(value)

    return {
        "domain": domain,
        "versionHash": (pack or {}).get("versionHash") or db_resolution.version_hash,
        "terms": [entry for entry in terms.values()],
        "normalizationMap": normalization_map,
    }
