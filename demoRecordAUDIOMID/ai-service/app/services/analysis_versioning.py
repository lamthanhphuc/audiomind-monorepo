"""Domain-aware analysis version resolution for cache identity."""

from __future__ import annotations

from typing import Any

STRUCTURED_DOMAIN_MODES = frozenset({"general", "it", "business", "education"})


def normalize_domain_mode(value: Any, *, default: str = "it") -> str:
    normalized = str(value or "").strip().lower()
    if normalized in STRUCTURED_DOMAIN_MODES:
        return normalized
    return default


def resolve_analysis_versions(domain_mode: str) -> dict[str, str]:
    normalized = normalize_domain_mode(domain_mode)
    if normalized == "education":
        return {
            "promptVersion": "education-analysis-v1",
            "schemaVersion": "education-study-v1",
            "analysisFeatureSet": "education-study-v1",
        }
    return {
        "promptVersion": "gemini-business-v2",
        "schemaVersion": "gemini-business-v2",
        "analysisFeatureSet": f"grouped-action-plan-v1-{normalized}",
    }


def merge_domain_analysis_payload(
    domain_mode: Any,
    payload: dict[str, Any] | None = None,
    *,
    default_domain: str = "it",
) -> tuple[str, dict[str, Any]]:
    normalized = normalize_domain_mode(domain_mode, default=default_domain)
    versions = resolve_analysis_versions(normalized)
    merged: dict[str, Any] = dict(payload or {})
    merged.setdefault("domainMode", normalized)
    merged.setdefault("domain_mode", normalized)
    merged.setdefault("promptVersion", versions["promptVersion"])
    merged.setdefault("schemaVersion", versions["schemaVersion"])
    merged.setdefault("analysisFeatureSet", versions["analysisFeatureSet"])
    return normalized, merged
