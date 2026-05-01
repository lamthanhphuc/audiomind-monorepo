from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from time import time
from typing import Optional

from app.models import GlossaryEntry
from app.schemas import GlossaryEntryCreate, GlossaryEntryUpdate
from app.services.glossary_repository import GlossaryRepository, GlossarySnapshot


@dataclass
class GlossaryResolution:
    terms: list[str]
    topic_defaults: dict[str, list[str]]
    normalization_map: dict[str, str]
    version_hash: str
    version_id: Optional[int]


class GlossaryService:
    def __init__(
        self, repository: GlossaryRepository, cache_ttl_seconds: int = 300
    ) -> None:
        self._repository = repository
        self._cache_ttl_seconds = max(0, int(cache_ttl_seconds))
        self._cache: dict[str, tuple[float, GlossarySnapshot]] = {}

    def list_entries(self, domain: Optional[str] = None) -> list[GlossaryEntry]:
        return self._repository.list_entries(domain)

    def resolve(self, domain: Optional[str] = None) -> GlossaryResolution:
        snapshot = self.get_snapshot(domain)
        return GlossaryResolution(
            terms=snapshot.terms,
            topic_defaults=snapshot.topic_defaults,
            normalization_map=snapshot.normalization_map,
            version_hash=snapshot.version_hash,
            version_id=snapshot.version_id,
        )

    def create_entry(self, payload: GlossaryEntryCreate) -> GlossaryEntry:
        entry = GlossaryEntry(
            term=payload.term.strip(),
            domain=(payload.domain or None),
            normalized=(payload.normalized or None),
        )
        return self._repository.create_entry(entry)

    def update_entry(
        self, entry_id: int, payload: GlossaryEntryUpdate
    ) -> GlossaryEntry:
        entry = self._repository.get_entry(entry_id)
        if entry is None:
            raise KeyError(f"Glossary entry not found: {entry_id}")

        if payload.term is not None:
            entry.term = payload.term.strip()
        if payload.domain is not None:
            entry.domain = payload.domain or None
        if payload.normalized is not None:
            entry.normalized = payload.normalized or None

        return self._repository.update_entry(entry)

    def delete_entry(self, entry_id: int) -> GlossaryEntry:
        entry = self._repository.get_entry(entry_id)
        if entry is None:
            raise KeyError(f"Glossary entry not found: {entry_id}")
        self._repository.delete_entry(entry)
        return entry

    def get_snapshot(self, domain: Optional[str] = None) -> GlossarySnapshot:
        cache_key = domain or "__all__"
        cached = self._cache.get(cache_key)
        if cached and cached[0] >= time():
            return cached[1]

        entries = self._repository.list_entries(domain)
        terms = [entry.term for entry in entries]
        topic_defaults = self._repository.get_topic_defaults(domain)
        normalization_map: dict[str, str] = {}
        for entry in entries:
            if entry.normalized:
                normalization_map[entry.normalized] = entry.term

        version_hash = self._compute_version_hash(entries)
        latest = self._repository.get_latest_version(domain)
        version_id = (
            latest.id if latest and latest.version_hash == version_hash else None
        )
        if latest is None or latest.version_hash != version_hash:
            version_id = self._repository.record_version(domain, version_hash).id

        snapshot = GlossarySnapshot(
            terms=terms,
            topic_defaults=topic_defaults,
            normalization_map=normalization_map,
            version_hash=version_hash,
            version_id=version_id,
        )

        if self._cache_ttl_seconds > 0:
            self._cache[cache_key] = (time() + self._cache_ttl_seconds, snapshot)
        return snapshot

    def invalidate(self, domain: Optional[str] = None) -> None:
        keys = [domain or "__all__"]
        if domain:
            keys.append("__all__")
        for key in keys:
            self._cache.pop(key, None)

    def resolve_domain_for_version(self, version_id: int) -> Optional[str]:
        return self._repository.resolve_domain_for_version(version_id)

    @staticmethod
    def _compute_version_hash(entries: list[GlossaryEntry]) -> str:
        normalized = [
            f"{entry.term}|{entry.domain or ''}|{entry.normalized or ''}"
            for entry in entries
        ]
        normalized.sort()
        payload = "\n".join(normalized)
        return sha256(payload.encode("utf-8")).hexdigest()
