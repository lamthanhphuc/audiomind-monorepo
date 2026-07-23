"""API key introspection helper shared by FastAPI routes/middleware."""

from __future__ import annotations

import httpx
from starlette.requests import Request

from app.config import get_settings


API_KEY_STATE_ATTR = "api_key_user"


def resolve_api_key(request: Request) -> str | None:
    explicit = request.headers.get("x-api-key")
    if explicit and explicit.strip():
        return explicit.strip()
    authorization = request.headers.get("authorization") or ""
    if authorization.startswith("ApiKey "):
        return authorization[len("ApiKey ") :].strip()
    return None


async def introspect_api_key(api_key: str, method: str, path: str) -> dict | None:
    settings = get_settings()
    if not settings.user_api_base_url or not settings.internal_service_token:
        return None
    url = settings.user_api_base_url.rstrip("/") + "/internal/api-keys/introspect"
    payload = {
        "apiKey": api_key,
        "callerService": "ai-service",
        "method": method,
        "path": path,
    }
    headers = {"X-Internal-Service-Token": settings.internal_service_token}
    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()
    if data.get("active") is True:
        return data
    return None


def has_required_scope(scopes: str | None, method: str) -> bool:
    normalized = {item.strip().lower() for item in (scopes or "read").split(",") if item.strip()}
    if "admin" in normalized:
        return True
    write = method.upper() not in {"GET", "HEAD", "OPTIONS"}
    if write:
        return "write" in normalized
    return bool({"read", "write"} & normalized)
