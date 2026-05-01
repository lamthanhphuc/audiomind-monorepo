from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.models import GlossaryEntry, GlossaryVersion


@dataclass
class GlossarySnapshot:
    terms: list[str]
    topic_defaults: dict[str, list[str]]
    normalization_map: dict[str, str]
    version_hash: str
    version_id: Optional[int]


class GlossaryRepository:
    def __init__(self, db: Session) -> None:
        self._db = db

    def list_entries(self, domain: Optional[str] = None) -> list[GlossaryEntry]:
        query = self._db.query(GlossaryEntry)
        if domain:
            query = query.filter(GlossaryEntry.domain == domain)
        return query.order_by(GlossaryEntry.term.asc()).all()

    def get_topic_defaults(self, domain: Optional[str] = None) -> dict[str, list[str]]:
        entries = self.list_entries(domain)
        grouped: dict[str, list[str]] = {}

        for entry in entries:
            topic = (entry.domain or "").strip().lower()
            if not topic:
                continue
            grouped.setdefault(topic, []).append(entry.term)

        topic_defaults: dict[str, list[str]] = {}
        for topic, terms in grouped.items():
            # Keep deterministic ordering and remove duplicates.
            topic_defaults[topic] = sorted(set(terms), key=str.lower)

        return topic_defaults

    def get_entry(self, entry_id: int) -> Optional[GlossaryEntry]:
        return (
            self._db.query(GlossaryEntry).filter(GlossaryEntry.id == entry_id).first()
        )

    def create_entry(self, entry: GlossaryEntry) -> GlossaryEntry:
        self._db.add(entry)
        self._db.commit()
        self._db.refresh(entry)
        return entry

    def update_entry(self, entry: GlossaryEntry) -> GlossaryEntry:
        self._db.add(entry)
        self._db.commit()
        self._db.refresh(entry)
        return entry

    def delete_entry(self, entry: GlossaryEntry) -> None:
        self._db.delete(entry)
        self._db.commit()

    def get_latest_version(
        self, domain: Optional[str] = None
    ) -> Optional[GlossaryVersion]:
        query = self._db.query(GlossaryVersion)
        if domain:
            query = query.filter(GlossaryVersion.domain == domain)
        return query.order_by(GlossaryVersion.created_at.desc()).first()

    def record_version(
        self, domain: Optional[str], version_hash: str
    ) -> GlossaryVersion:
        version = GlossaryVersion(domain=domain, version_hash=version_hash)
        self._db.add(version)
        self._db.commit()
        self._db.refresh(version)
        return version

    def resolve_domain_for_version(self, version_id: int) -> Optional[str]:
        version = (
            self._db.query(GlossaryVersion)
            .filter(GlossaryVersion.id == version_id)
            .first()
        )
        return version.domain if version else None
