#!/usr/bin/env python3
"""Phase 2 API smoke for staging subject synthesis + study artifacts.

Env gates:
  SMOKE_PHASE2=false          -> NOT RUN (exit 0)
  RUN_PHASE2_SMOKE=true       -> required creds must be present or FAIL
  APP_ENV=production          -> FAIL unless FORCE_PROD_SMOKE is set
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

ARTIFACT_TYPES = (
    "MIND_MAP",
    "FLASHCARDS",
    "MULTIPLE_CHOICE",
    "ESSAY_QUESTIONS",
    "EXAM_BRIEF",
)

POLL_SECONDS = int(os.environ.get("SMOKE_PHASE2_POLL_SECONDS", "5"))
POLL_ATTEMPTS = int(os.environ.get("SMOKE_PHASE2_POLL_ATTEMPTS", "24"))


def _truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _fail(message: str) -> None:
    print(f"FAIL smoke-phase2-staging: {message}", file=sys.stderr)
    sys.exit(1)


def _not_run(reason: str) -> None:
    print(f"NOT RUN smoke-phase2-staging: {reason}")
    sys.exit(0)


def _resolve_bases() -> tuple[str, str, str]:
    base = os.environ.get("BASE_URL", "").rstrip("/")
    user = os.environ.get("USER_API_BASE", f"{base}/api/users" if base else "").rstrip("/")
    meeting = os.environ.get("MEETING_API_BASE", "").rstrip("/")
    processing = os.environ.get("PROCESSING_API_BASE", "").rstrip("/")
    if base and not meeting:
        meeting = f"{base}/api/meetings"
    if base and not processing:
        processing = f"{base}/api/processing"
    if not user:
        user = os.environ.get("USER_SERVICE_URL", "http://localhost:8083").rstrip("/")
    if not meeting:
        meeting = os.environ.get("MEETING_SERVICE_URL", "http://localhost:8081").rstrip("/")
    if not processing:
        processing = os.environ.get("PROCESSING_SERVICE_URL", "http://localhost:8082").rstrip("/")
    return user, meeting, processing


def _request(
    method: str,
    url: str,
    *,
    token: str | None = None,
    body: dict[str, Any] | None = None,
    timeout: float = 60.0,
) -> tuple[int, Any]:
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers["x-trace-id"] = str(uuid.uuid4())
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return resp.status, None
            return resp.status, json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else None
        except json.JSONDecodeError:
            payload = raw.decode("utf-8", errors="replace")
        return exc.code, payload


def _resolve_token(user_base: str) -> str:
    token = os.environ.get("JWT_TOKEN") or os.environ.get("SMOKE_JWT")
    if token:
        return token.strip()
    username = os.environ.get("SMOKE_USERNAME")
    password = os.environ.get("SMOKE_PASSWORD")
    if not username or not password:
        return ""
    status, payload = _request(
        "POST",
        f"{user_base}/login",
        body={"username": username, "password": password},
    )
    if status != 200 or not isinstance(payload, dict):
        _fail(f"login failed status={status}")
    token_val = payload.get("accessToken") or payload.get("token")
    if not token_val:
        _fail("login response missing accessToken")
    return str(token_val)


def _ensure_subject(meeting_base: str, token: str) -> int:
    if os.environ.get("SMOKE_SUBJECT_ID"):
        return int(os.environ["SMOKE_SUBJECT_ID"])
    status, payload = _request(
        "POST",
        f"{meeting_base}/subjects",
        token=token,
        body={"name": f"phase2-smoke-{uuid.uuid4().hex[:8]}", "code": "SMOKE"},
    )
    if status not in {200, 201} or not isinstance(payload, dict):
        _fail(f"create subject failed status={status}")
    subject_id = payload.get("id")
    if subject_id is None:
        _fail("create subject response missing id")
    return int(subject_id)


def _poll_synthesis(processing_base: str, token: str, subject_id: int) -> dict[str, Any]:
    for attempt in range(1, POLL_ATTEMPTS + 1):
        status, payload = _request(
            "GET",
            f"{processing_base}/processing/subjects/{subject_id}/synthesis/status",
            token=token,
        )
        if status == 404:
            return {"status": "NOT_FOUND"}
        if status != 200 or not isinstance(payload, dict):
            _fail(f"synthesis status failed status={status}")
        synthesis = payload.get("synthesis") if isinstance(payload.get("synthesis"), dict) else payload
        agg = synthesis.get("aggregateStatus") or synthesis.get("status")
        print(f"  synthesis poll {attempt}/{POLL_ATTEMPTS}: {agg}")
        if agg in {"COMPLETED", "PARTIALLY_FAILED", "FAILED", "NOT_FOUND"}:
            return synthesis
        time.sleep(POLL_SECONDS)
    _fail("synthesis status poll timed out")
    raise AssertionError


def _poll_artifact(processing_base: str, token: str, artifact_id: int) -> dict[str, Any]:
    for attempt in range(1, POLL_ATTEMPTS + 1):
        status, payload = _request(
            "GET",
            f"{processing_base}/processing/study-artifacts/{artifact_id}",
            token=token,
        )
        if status != 200 or not isinstance(payload, dict):
            _fail(f"artifact get failed id={artifact_id} status={status}")
        agg = payload.get("aggregateStatus") or payload.get("status")
        print(f"  artifact {artifact_id} poll {attempt}/{POLL_ATTEMPTS}: {agg}")
        if agg in {"COMPLETED", "PARTIALLY_FAILED", "FAILED"}:
            return payload
        time.sleep(POLL_SECONDS)
    _fail(f"artifact {artifact_id} poll timed out")
    raise AssertionError


def main() -> int:
    if os.environ.get("SMOKE_PHASE2", "").strip().lower() == "false":
        _not_run("SMOKE_PHASE2=false")

    run_requested = _truthy("RUN_PHASE2_SMOKE") or _truthy("SMOKE_PHASE2")
    if not run_requested:
        _not_run("set RUN_PHASE2_SMOKE=true (or SMOKE_PHASE2=true) to enable")

    if os.environ.get("APP_ENV", "").strip().lower() == "production" and not _truthy("FORCE_PROD_SMOKE"):
        _fail("refusing to run against APP_ENV=production (set FORCE_PROD_SMOKE=true to override)")

    user_base, meeting_base, processing_base = _resolve_bases()
    has_creds = bool(
        (os.environ.get("JWT_TOKEN") or os.environ.get("SMOKE_JWT"))
        or (os.environ.get("SMOKE_USERNAME") and os.environ.get("SMOKE_PASSWORD"))
    )
    if not has_creds:
        if _truthy("RUN_PHASE2_SMOKE"):
            _fail("RUN_PHASE2_SMOKE=true but JWT_TOKEN or SMOKE_USERNAME/SMOKE_PASSWORD missing")
        _not_run("missing JWT_TOKEN or SMOKE_USERNAME/SMOKE_PASSWORD")

    token = _resolve_token(user_base)

    print("smoke-phase2-staging: starting (secrets not logged)")
    subject_id = _ensure_subject(meeting_base, token)
    print(f"  subjectId={subject_id}")

    status, synth_create = _request(
        "POST",
        f"{processing_base}/processing/subjects/{subject_id}/synthesis",
        token=token,
        body={"language": "vi", "sourceSelectionMode": "ALL_READY"},
    )
    if status not in {200, 201, 202}:
        _fail(f"create synthesis failed status={status}")
    print(f"  synthesis create status={status}")

    synthesis = _poll_synthesis(processing_base, token, subject_id)
    print(f"  synthesis aggregate={synthesis.get('aggregateStatus') or synthesis.get('status')}")

    status, artifacts_resp = _request(
        "POST",
        f"{processing_base}/processing/study-artifacts",
        token=token,
        body={
            "subjectId": subject_id,
            "artifactTypes": list(ARTIFACT_TYPES),
            "sourceSelectionMode": "ALL_READY",
            "options": {
                "language": "vi",
                "difficulty": "MIXED",
                "flashcardCount": 5,
                "multipleChoiceCount": 3,
                "essayQuestionCount": 2,
            },
        },
    )
    if status not in {200, 201, 202}:
        _fail(f"create artifacts failed status={status}")
    artifact_ids: list[int] = []
    if isinstance(artifacts_resp, dict):
        for key in ("artifactIds", "artifacts", "items"):
            val = artifacts_resp.get(key)
            if isinstance(val, list):
                for item in val:
                    if isinstance(item, dict) and item.get("id") is not None:
                        artifact_ids.append(int(item["id"]))
                    elif isinstance(item, int):
                        artifact_ids.append(item)
                break
        if not artifact_ids and artifacts_resp.get("id") is not None:
            artifact_ids.append(int(artifacts_resp["id"]))
    print(f"  requested artifact types={len(ARTIFACT_TYPES)} ids={artifact_ids or 'pending-list'}")

    if artifact_ids:
        for artifact_id in artifact_ids[:5]:
            result = _poll_artifact(processing_base, token, artifact_id)
            print(f"  artifact {artifact_id} final={result.get('aggregateStatus') or result.get('status')}")

    status, regen = _request(
        "POST",
        f"{processing_base}/processing/subjects/{subject_id}/synthesis/regenerate",
        token=token,
        body={"language": "vi", "sourceSelectionMode": "ALL_READY"},
    )
    if status not in {200, 201, 202}:
        _fail(f"synthesis regenerate failed status={status}")
    print(f"  synthesis regenerate status={status}")

    status, listed = _request(
        "GET",
        f"{processing_base}/processing/subjects/{subject_id}/study-artifacts?page=0&size=10",
        token=token,
    )
    if status != 200:
        _fail(f"list artifacts failed status={status}")
    count = 0
    if isinstance(listed, dict):
        items = listed.get("items") or listed.get("content") or listed.get("artifacts") or []
        if isinstance(items, list):
            count = len(items)
    print(f"  listed artifacts count={count}")

    print("PASS smoke-phase2-staging")
    return 0


if __name__ == "__main__":
    sys.exit(main())
