#!/usr/bin/env python3
"""Phase 2 API smoke for staging subject synthesis + study artifacts.

Env gates:
  RUN_PHASE2_SMOKE=true       -> run (FAIL if creds/fixture missing)
  RUN_PHASE2_SMOKE unset/false -> NOT RUN (exit 0)
  APP_ENV=production          -> FAIL unless FORCE_PROD_SMOKE=true

Fixture:
  SMOKE_SUBJECT_ID + SMOKE_READY_MEETING_IDS (comma-separated), or
  self-create subject + assign ready meetings (cleanup on exit).
"""

from __future__ import annotations

import atexit
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any

ARTIFACT_TYPES = (
    "MIND_MAP",
    "FLASHCARDS",
    "MULTIPLE_CHOICE",
    "ESSAY_QUESTIONS",
    "EXAM_BRIEF",
)

TERMINAL_STATUSES = frozenset(
    {"COMPLETED", "FAILED", "PARTIALLY_FAILED", "QUOTA_EXCEEDED", "STALE"}
)
ARTIFACT_TERMINAL_OK = frozenset({"COMPLETED", "PARTIALLY_FAILED"})

POLL_SECONDS = int(os.environ.get("SMOKE_PHASE2_POLL_SECONDS", "5"))
POLL_ATTEMPTS = int(os.environ.get("SMOKE_PHASE2_POLL_ATTEMPTS", "36"))

ARTIFACT_OPTIONS: dict[str, Any] = {
    "language": "vi",
    "difficulty": "MIXED",
    "flashcardCount": 5,
    "multipleChoiceCount": 5,
    "essayQuestionCount": 3,
}

_SECRET_PATTERNS = (
    re.compile(r"(Bearer\s+)[^\s\"']+", re.I),
    re.compile(r"((?:password|token|secret|api[_-]?key)\s*[:=]\s*)[^\s,\"']+", re.I),
    re.compile(r"(postgresql://)[^@\s]+@", re.I),
    re.compile(r"(jdbc:postgresql://)[^@\s]+@", re.I),
)


def _truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _log(message: str) -> None:
    print(_redact(message))


def _redact(text: str) -> str:
    redacted = text
    for pattern in _SECRET_PATTERNS:
        redacted = pattern.sub(r"\1***", redacted)
    return redacted


def _fail(message: str) -> None:
    print(f"FAIL smoke-phase2-staging: {_redact(message)}", file=sys.stderr)
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
    timeout: float = 120.0,
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
        _fail(f"login failed status={status} body={payload!r}")
    token_val = payload.get("accessToken") or payload.get("token")
    if not token_val:
        _fail("login response missing accessToken")
    return str(token_val)


def _parse_meeting_ids(raw: str) -> list[int]:
    ids: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        ids.append(int(part))
    if not ids:
        _fail("SMOKE_READY_MEETING_IDS parsed to empty list")
    return ids


def _extract_status(payload: dict[str, Any]) -> str:
    if payload.get("aggregateStatus"):
        return str(payload["aggregateStatus"])
    if payload.get("status"):
        return str(payload["status"])
    synthesis = payload.get("synthesis")
    if isinstance(synthesis, dict):
        return str(synthesis.get("aggregateStatus") or synthesis.get("status") or "")
    return ""


@dataclass
class Fixture:
    meeting_base: str
    token: str
    subject_id: int | None = None
    meeting_ids: list[int] = field(default_factory=list)
    created_subject: bool = False
    assigned_meetings: list[int] = field(default_factory=list)

    def cleanup(self) -> None:
        if not self.created_subject:
            return
        for meeting_id in self.assigned_meetings:
            _request(
                "PATCH",
                f"{self.meeting_base}/meetings/{meeting_id}/subject",
                token=self.token,
                body={"subjectId": None},
            )
        if self.subject_id is not None:
            _request(
                "DELETE",
                f"{self.meeting_base}/subjects/{self.subject_id}",
                token=self.token,
            )


def _ensure_fixture(meeting_base: str, token: str) -> Fixture:
    fixture = Fixture(meeting_base=meeting_base, token=token)
    subject_env = os.environ.get("SMOKE_SUBJECT_ID", "").strip()
    meetings_env = os.environ.get("SMOKE_READY_MEETING_IDS", "").strip()

    if subject_env and not meetings_env:
        _fail("SMOKE_SUBJECT_ID requires SMOKE_READY_MEETING_IDS")
    if subject_env and meetings_env:
        fixture.subject_id = int(subject_env)
        fixture.meeting_ids = _parse_meeting_ids(meetings_env)
        _log(f"  using fixture subjectId={fixture.subject_id} meetings={fixture.meeting_ids}")
        return fixture

    if not meetings_env:
        _fail(
            "fixture requires SMOKE_READY_MEETING_IDS "
            "(ready meetings with educationStudy must be assigned to the subject)"
        )

    tag = uuid.uuid4().hex[:8]
    status, payload = _request(
        "POST",
        f"{meeting_base}/subjects",
        token=token,
        body={"name": f"phase2-smoke-{tag}", "code": f"SMOKE-{tag}"},
    )
    if status not in {200, 201} or not isinstance(payload, dict) or payload.get("id") is None:
        _fail(f"create subject failed status={status}")
    fixture.subject_id = int(payload["id"])
    fixture.created_subject = True
    fixture.meeting_ids = _parse_meeting_ids(meetings_env)

    for meeting_id in fixture.meeting_ids:
        status, _ = _request(
            "PATCH",
            f"{meeting_base}/meetings/{meeting_id}/subject",
            token=token,
            body={"subjectId": fixture.subject_id},
        )
        if status not in {200, 204}:
            _fail(f"assign meeting {meeting_id} to subject failed status={status}")
        fixture.assigned_meetings.append(meeting_id)

    _log(
        f"  created fixture subjectId={fixture.subject_id} "
        f"assignedMeetings={fixture.meeting_ids}"
    )
    return fixture


def _quota_usage(user_base: str, token: str) -> dict[str, int]:
    status, payload = _request("GET", f"{user_base}/api/billing/me", token=token)
    if status != 200 or not isinstance(payload, dict):
        _fail(f"billing/me failed status={status}")
    quota = payload.get("quota") if isinstance(payload.get("quota"), dict) else {}
    return {
        "geminiInputCharsUsed": int(
            quota.get("geminiInputCharsUsed") or quota.get("gemini_input_chars_used") or 0
        ),
        "sttSecondsUsed": int(
            quota.get("sttSecondsUsed") or quota.get("stt_seconds_used") or 0
        ),
    }


def _poll_synthesis(
    processing_base: str, token: str, subject_id: int
) -> dict[str, Any]:
    for attempt in range(1, POLL_ATTEMPTS + 1):
        status, payload = _request(
            "GET",
            f"{processing_base}/processing/subjects/{subject_id}/synthesis/status",
            token=token,
        )
        if status == 404:
            _fail("synthesis status 404 — subject has no synthesis job")
        if status != 200 or not isinstance(payload, dict):
            _fail(f"synthesis status failed status={status}")
        synthesis = payload.get("synthesis") if isinstance(payload.get("synthesis"), dict) else payload
        agg = _extract_status(synthesis if isinstance(synthesis, dict) else payload)
        _log(f"  synthesis poll {attempt}/{POLL_ATTEMPTS}: {agg}")
        if agg in TERMINAL_STATUSES:
            return synthesis if isinstance(synthesis, dict) else payload
        time.sleep(POLL_SECONDS)
    _fail("synthesis status poll timed out")
    raise AssertionError


def _require_synthesis_completed(synthesis: dict[str, Any], *, label: str) -> None:
    status = _extract_status(synthesis)
    if status == "COMPLETED":
        content = synthesis.get("content")
        if not isinstance(content, dict) or not content:
            _fail(f"{label} synthesis COMPLETED but content missing/empty")
        return
    if status == "PARTIALLY_FAILED" and synthesis.get("partialQuota") is True:
        details = synthesis.get("quotaDetails")
        if isinstance(details, list) and details:
            _log(f"  {label} synthesis PARTIALLY_FAILED with explicit quotaDetails")
            return
    _fail(f"{label} synthesis ended {status!r}, expected COMPLETED")


def _create_synthesis(
    processing_base: str,
    token: str,
    subject_id: int,
    *,
    mode: str,
    meeting_ids: list[int] | None,
    regenerate: bool = False,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "language": "vi",
        "sourceSelectionMode": mode,
    }
    if mode == "EXPLICIT":
        if not meeting_ids:
            _fail("EXPLICIT synthesis requires meetingIds")
        body["meetingIds"] = meeting_ids
    path = (
        f"{processing_base}/processing/subjects/{subject_id}/synthesis/regenerate"
        if regenerate
        else f"{processing_base}/processing/subjects/{subject_id}/synthesis"
    )
    status, payload = _request("POST", path, token=token, body=body)
    if status not in {200, 201, 202}:
        _fail(f"synthesis {'regenerate' if regenerate else 'create'} failed status={status}")
    if not isinstance(payload, dict):
        _fail("synthesis response not an object")
    return payload


def _extract_artifact_ids(payload: dict[str, Any]) -> list[int]:
    ids: list[int] = []
    for key in ("artifactIds", "newlyCreatedArtifactIds"):
        val = payload.get(key)
        if isinstance(val, list):
            for item in val:
                if isinstance(item, int):
                    ids.append(item)
                elif isinstance(item, dict) and item.get("id") is not None:
                    ids.append(int(item["id"]))
    if not ids:
        artifacts = payload.get("artifacts")
        if isinstance(artifacts, list):
            for item in artifacts:
                if isinstance(item, dict) and item.get("id") is not None:
                    ids.append(int(item["id"]))
    # Preserve order, drop duplicates
    seen: set[int] = set()
    ordered: list[int] = []
    for aid in ids:
        if aid not in seen:
            seen.add(aid)
            ordered.append(aid)
    return ordered


def _create_artifacts(
    processing_base: str,
    token: str,
    subject_id: int,
    *,
    mode: str,
    meeting_ids: list[int] | None,
    synthesis_id: int | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "subjectId": subject_id,
        "artifactTypes": list(ARTIFACT_TYPES),
        "sourceSelectionMode": mode,
        "options": dict(ARTIFACT_OPTIONS),
    }
    if mode == "EXPLICIT":
        if not meeting_ids:
            _fail("EXPLICIT artifacts require meetingIds")
        body["meetingIds"] = meeting_ids
    if synthesis_id is not None:
        body["synthesisId"] = synthesis_id
    status, payload = _request(
        "POST",
        f"{processing_base}/processing/study-artifacts",
        token=token,
        body=body,
    )
    if status not in {200, 201, 202}:
        _fail(f"create artifacts failed status={status}")
    if not isinstance(payload, dict):
        _fail("create artifacts response not an object")
    artifact_ids = _extract_artifact_ids(payload)
    if len(artifact_ids) != len(ARTIFACT_TYPES):
        _fail(
            f"expected {len(ARTIFACT_TYPES)} artifactIds, got {len(artifact_ids)}: {artifact_ids}"
        )
    return payload


def _poll_artifact(
    processing_base: str, token: str, artifact_id: int
) -> dict[str, Any]:
    for attempt in range(1, POLL_ATTEMPTS + 1):
        status, payload = _request(
            "GET",
            f"{processing_base}/processing/study-artifacts/{artifact_id}",
            token=token,
        )
        if status != 200 or not isinstance(payload, dict):
            _fail(f"artifact get failed id={artifact_id} status={status}")
        agg = _extract_status(payload)
        _log(f"  artifact {artifact_id} poll {attempt}/{POLL_ATTEMPTS}: {agg}")
        if agg in TERMINAL_STATUSES:
            return payload
        time.sleep(POLL_SECONDS)
    _fail(f"artifact {artifact_id} poll timed out")
    raise AssertionError


def _require_artifact_terminal(artifact: dict[str, Any]) -> None:
    status = _extract_status(artifact)
    if status == "COMPLETED":
        return
    if status == "PARTIALLY_FAILED" and artifact.get("partialQuota") is True:
        details = artifact.get("quotaDetails")
        if isinstance(details, list) and details:
            return
    _fail(
        f"artifact {artifact.get('id')} type={artifact.get('artifactType')} "
        f"ended {status!r}, expected COMPLETED"
    )


def _has_evidence(item: dict[str, Any]) -> bool:
    mids = item.get("sourceMeetingIds") or item.get("meetingIds")
    sids = item.get("sourceSegmentIds") or item.get("segmentIds")
    if isinstance(mids, list) and mids and isinstance(sids, list) and sids:
        return True
    evidence = item.get("evidence")
    if isinstance(evidence, list):
        for pair in evidence:
            if not isinstance(pair, dict):
                continue
            mid = pair.get("meetingId") or pair.get("meeting_id")
            sid = pair.get("segmentId") or pair.get("segment_id")
            if mid is not None and sid:
                return True
    return False


def _validate_mind_map(content: dict[str, Any]) -> None:
    root = content.get("root")
    nodes = content.get("nodes")
    edges = content.get("edges")
    if not isinstance(root, dict) or not str(root.get("label", "")).strip():
        _fail("MIND_MAP missing root.label")
    if not isinstance(nodes, list) or not nodes:
        _fail("MIND_MAP missing nodes")
    if not isinstance(edges, list):
        _fail("MIND_MAP missing edges array")
    for node in nodes:
        if not isinstance(node, dict) or not str(node.get("id", "")).strip():
            _fail("MIND_MAP node missing id")
        if not str(node.get("label", "")).strip():
            _fail("MIND_MAP node missing label")
    for edge in edges:
        if not isinstance(edge, dict):
            _fail("MIND_MAP edge invalid")
        if not edge.get("source") or not edge.get("target"):
            _fail("MIND_MAP edge missing source/target")


def _validate_flashcards(content: dict[str, Any]) -> None:
    cards = content.get("cards")
    if not isinstance(cards, list) or not cards:
        _fail("FLASHCARDS missing cards")
    for card in cards:
        if not isinstance(card, dict):
            _fail("FLASHCARDS invalid card")
        if not str(card.get("front", "")).strip() or not str(card.get("back", "")).strip():
            _fail("FLASHCARDS card missing front/back")


def _validate_mcq(content: dict[str, Any]) -> None:
    questions = content.get("questions")
    if not isinstance(questions, list) or not questions:
        _fail("MULTIPLE_CHOICE missing questions")
    for q in questions:
        if not isinstance(q, dict):
            _fail("MULTIPLE_CHOICE invalid question")
        options = q.get("options")
        if not isinstance(options, list) or len(options) < 2:
            _fail("MULTIPLE_CHOICE question missing choices/options")
        if not str(q.get("question", "")).strip():
            _fail("MULTIPLE_CHOICE question text empty")
        if not q.get("correctOptionId"):
            _fail("MULTIPLE_CHOICE missing correctOptionId")


def _validate_essay(content: dict[str, Any]) -> None:
    questions = content.get("questions")
    if not isinstance(questions, list) or not questions:
        _fail("ESSAY_QUESTIONS missing questions")
    for q in questions:
        if not isinstance(q, dict):
            _fail("ESSAY_QUESTIONS invalid question")
        rubric = q.get("rubric")
        if not isinstance(rubric, list) or not rubric:
            _fail("ESSAY_QUESTIONS missing rubric")
        ok = False
        for item in rubric:
            if isinstance(item, dict) and str(item.get("criterion", "")).strip():
                ok = True
                break
        if not ok:
            _fail("ESSAY_QUESTIONS rubric missing criterion")


def _validate_exam_brief(content: dict[str, Any]) -> None:
    if not str(content.get("overview", "")).strip():
        _fail("EXAM_BRIEF missing overview")
    section_keys = (
        "mustRemember",
        "importantTerms",
        "likelyExamTopics",
        "lastMinuteChecklist",
        "commonMistakes",
    )
    if not any(isinstance(content.get(k), list) and content.get(k) for k in section_keys):
        _fail("EXAM_BRIEF missing section lists")


def _validate_artifact_content(artifact: dict[str, Any]) -> None:
    artifact_type = str(artifact.get("artifactType") or "")
    content = artifact.get("content")
    if not isinstance(content, dict) or not content:
        _fail(f"artifact {artifact.get('id')} type={artifact_type} missing content")

    validators = {
        "MIND_MAP": _validate_mind_map,
        "FLASHCARDS": _validate_flashcards,
        "MULTIPLE_CHOICE": _validate_mcq,
        "ESSAY_QUESTIONS": _validate_essay,
        "EXAM_BRIEF": _validate_exam_brief,
    }
    validator = validators.get(artifact_type)
    if validator is None:
        _fail(f"unknown artifact type {artifact_type!r}")
    validator(content)

    evidence_checked = False
    if artifact_type == "MIND_MAP":
        for node in content.get("nodes") or []:
            if isinstance(node, dict) and _has_evidence(node):
                evidence_checked = True
                break
    elif artifact_type == "FLASHCARDS":
        for card in content.get("cards") or []:
            if isinstance(card, dict) and _has_evidence(card):
                evidence_checked = True
                break
    elif artifact_type in {"MULTIPLE_CHOICE", "ESSAY_QUESTIONS"}:
        for q in content.get("questions") or []:
            if isinstance(q, dict) and _has_evidence(q):
                evidence_checked = True
                break
    elif artifact_type == "EXAM_BRIEF":
        evidence_checked = _has_evidence(content)

    if not evidence_checked:
        _log(
            f"  note: artifact {artifact.get('id')} ({artifact_type}) has no meetingId+segmentId evidence"
        )


def _collect_idempotency_keys(payload: dict[str, Any]) -> list[str]:
    keys: list[str] = []
    details = payload.get("quotaDetails")
    if isinstance(details, list):
        for item in details:
            if isinstance(item, dict):
                key = item.get("idempotencyKey")
                if key:
                    keys.append(str(key))
    return keys


def _verify_idempotent_quota(
    processing_base: str,
    token: str,
    user_base: str,
    subject_id: int,
    *,
    mode: str,
    meeting_ids: list[int] | None,
    synthesis_id: int | None,
    first_create: dict[str, Any],
    usage_after_first: dict[str, int],
) -> None:
    keys = _collect_idempotency_keys(first_create)
    if not keys:
        _log("  note: no quotaDetails idempotencyKey on artifact create")
    duplicate = _create_artifacts(
        processing_base,
        token,
        subject_id,
        mode=mode,
        meeting_ids=meeting_ids,
        synthesis_id=synthesis_id,
    )
    after_usage = _quota_usage(user_base, token)
    if after_usage["geminiInputCharsUsed"] > usage_after_first["geminiInputCharsUsed"]:
        _fail(
            "idempotent artifact recreate increased geminiInputCharsUsed "
            f"{usage_after_first} -> {after_usage}"
        )
    cache_hits = duplicate.get("cacheHitArtifactIds")
    if isinstance(cache_hits, list) and cache_hits:
        _log(f"  idempotency cacheHitArtifactIds={len(cache_hits)}")
    elif not duplicate.get("partialQuota"):
        _log("  note: duplicate artifact create returned no cacheHitArtifactIds")


def _run_mode_flow(
    processing_base: str,
    token: str,
    user_base: str,
    fixture: Fixture,
    *,
    mode: str,
    check_quota: bool,
) -> None:
    meeting_ids = fixture.meeting_ids if mode == "EXPLICIT" else None
    label = mode
    _log(f"--- mode {label} ---")

    synth = _create_synthesis(
        processing_base,
        token,
        fixture.subject_id,
        mode=mode,
        meeting_ids=meeting_ids,
        regenerate=False,
    )
    _log(f"  synthesis create status={_extract_status(synth) or 'accepted'}")
    synthesis = _poll_synthesis(processing_base, token, fixture.subject_id)
    _require_synthesis_completed(synthesis, label=label)

    regen = _create_synthesis(
        processing_base,
        token,
        fixture.subject_id,
        mode=mode,
        meeting_ids=meeting_ids,
        regenerate=True,
    )
    _log(f"  synthesis regenerate accepted status={_extract_status(regen) or 'accepted'}")
    synthesis_after_regen = _poll_synthesis(processing_base, token, fixture.subject_id)
    _require_synthesis_completed(synthesis_after_regen, label=f"{label}-regen")

    synthesis_id = (
        int(synthesis_after_regen["id"])
        if synthesis_after_regen.get("id") is not None
        else None
    )
    create_resp = _create_artifacts(
        processing_base,
        token,
        fixture.subject_id,
        mode=mode,
        meeting_ids=meeting_ids,
        synthesis_id=synthesis_id,
    )
    usage_after_create = _quota_usage(user_base, token) if check_quota else {}
    artifact_ids = _extract_artifact_ids(create_resp)
    if len(artifact_ids) != 5:
        _fail(f"{label}: expected 5 artifactIds, got {artifact_ids}")

    by_type: dict[str, dict[str, Any]] = {}
    for artifact_id in artifact_ids:
        result = _poll_artifact(processing_base, token, artifact_id)
        _require_artifact_terminal(result)
        artifact_type = str(result.get("artifactType") or "")
        by_type[artifact_type] = result
        _validate_artifact_content(result)
        _log(
            f"  artifact {artifact_id} {artifact_type} final={_extract_status(result)}"
        )

    missing_types = [t for t in ARTIFACT_TYPES if t not in by_type]
    if missing_types:
        _fail(f"{label}: missing artifact types after poll: {missing_types}")

    if check_quota:
        _verify_idempotent_quota(
            processing_base,
            token,
            user_base,
            fixture.subject_id,
            mode=mode,
            meeting_ids=meeting_ids,
            synthesis_id=synthesis_id,
            first_create=create_resp,
            usage_after_first=usage_after_create,
        )


def main() -> int:
    if not _truthy("RUN_PHASE2_SMOKE"):
        _not_run("set RUN_PHASE2_SMOKE=true to enable")

    if os.environ.get("APP_ENV", "").strip().lower() == "production" and not _truthy(
        "FORCE_PROD_SMOKE"
    ):
        _fail("refusing to run against APP_ENV=production (set FORCE_PROD_SMOKE=true to override)")

    has_creds = bool(
        (os.environ.get("JWT_TOKEN") or os.environ.get("SMOKE_JWT"))
        or (os.environ.get("SMOKE_USERNAME") and os.environ.get("SMOKE_PASSWORD"))
    )
    if not has_creds:
        _fail("RUN_PHASE2_SMOKE=true but JWT_TOKEN or SMOKE_USERNAME/SMOKE_PASSWORD missing")

    user_base, meeting_base, processing_base = _resolve_bases()
    token = _resolve_token(user_base)

    _log("smoke-phase2-staging: starting (credentials redacted in logs)")
    fixture = _ensure_fixture(meeting_base, token)
    if fixture.subject_id is None:
        _fail("subjectId missing after fixture setup")
    atexit.register(fixture.cleanup)

    _run_mode_flow(
        processing_base,
        token,
        user_base,
        fixture,
        mode="ALL_READY",
        check_quota=True,
    )
    _run_mode_flow(
        processing_base,
        token,
        user_base,
        fixture,
        mode="EXPLICIT",
        check_quota=False,
    )

    status, listed = _request(
        "GET",
        f"{processing_base}/processing/subjects/{fixture.subject_id}/study-artifacts?page=1&size=20",
        token=token,
    )
    if status != 200:
        _fail(f"list artifacts failed status={status}")
    count = 0
    if isinstance(listed, dict):
        items = listed.get("items") or listed.get("content") or listed.get("artifacts") or []
        if isinstance(items, list):
            count = len(items)
    if count < len(ARTIFACT_TYPES):
        _fail(f"listed artifacts count={count}, expected at least {len(ARTIFACT_TYPES)}")
    _log(f"  listed artifacts count={count}")

    _log("PASS smoke-phase2-staging")
    return 0


if __name__ == "__main__":
    sys.exit(main())
