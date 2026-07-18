#!/usr/bin/env python3
"""Offline structural validation for kubectl-kustomize rendered overlays.

Supports --environment {dev,staging,prod} for managed-DB / internal-DB guards.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]

_PLACEHOLDER_EXACT = {
    "replace_me",
    "replace_in_overlay",
    "replace_in_overlay_with_at_least_32_chars",
    "change-me",
    "changeme",
    "empty",
    "",
}

_DB_PLACEHOLDER_TOKENS = (
    "your-managed-db-host",
    "your_username",
    "your_password",
    "replace_me_db",
    "change_me_db",
)

_INTERNAL_DB_HOST_PATTERNS = (
    re.compile(r"://db(?::|/|\?)"),
    re.compile(r"@db(?::|/)"),
    re.compile(r"://localhost(?::|/|\?)"),
    re.compile(r"@localhost(?::|/)"),
    re.compile(r"://127\.0\.0\.1(?::|/|\?)"),
    re.compile(r"@127\.0\.0\.1(?::|/)"),
    re.compile(r"host\.docker\.internal"),
)

_DB_ENV_NAMES = {
    "SPRING_DATASOURCE_URL",
    "DATABASE_URL",
    "MEETING_DATABASE_URL",
    "USER_DATABASE_URL",
    "AI_DATABASE_URL",
    "PROCESSING_DATABASE_URL",
}

_JAVA_DB_DEPLOYMENTS = {
    "meeting-api-deployment": "MEETING_DATABASE_URL",
    "user-api-deployment": "USER_DATABASE_URL",
}
_PYTHON_DB_DEPLOYMENTS = {
    "ai-api-deployment",
    "celery-worker-deployment",
}


def _load_docs(path: Path) -> list[dict[str, Any]]:
    return [d for d in yaml.safe_load_all(path.read_text(encoding="utf-8")) if d]


def _secret_target_name(doc: dict[str, Any]) -> str | None:
    kind = doc.get("kind")
    meta = doc.get("metadata") or {}
    if kind == "Secret":
        return meta.get("name")
    if kind == "SealedSecret":
        tmpl = ((doc.get("spec") or {}).get("template") or {}).get("metadata") or {}
        return tmpl.get("name") or meta.get("name")
    if kind == "ExternalSecret":
        target = (doc.get("spec") or {}).get("target") or {}
        return target.get("name") or meta.get("name")
    return None


def _producer_keys(doc: dict[str, Any]) -> set[str]:
    kind = doc.get("kind")
    if kind == "Secret":
        return set(doc.get("stringData") or {}) | set(doc.get("data") or {})
    if kind == "SealedSecret":
        return set((doc.get("spec") or {}).get("encryptedData") or {})
    if kind == "ExternalSecret":
        keys: set[str] = set()
        for item in (doc.get("spec") or {}).get("data") or []:
            if isinstance(item, dict) and item.get("secretKey"):
                keys.add(str(item["secretKey"]))
        if (doc.get("spec") or {}).get("dataFrom"):
            keys.add("*")
        return keys
    return set()


def _is_bad_jwt_plaintext(value: str) -> str | None:
    raw = (value or "").strip()
    lowered = raw.lower()
    if lowered in _PLACEHOLDER_EXACT or lowered.startswith("replace_me"):
        return "placeholder/empty"
    if len(raw) < 32:
        return f"length {len(raw)} < 32"
    return None


def _contains_db_placeholder(text: str) -> bool:
    lowered = text.lower()
    return any(token in lowered for token in _DB_PLACEHOLDER_TOKENS)


def _contains_internal_db_host(text: str) -> bool:
    return any(p.search(text) for p in _INTERNAL_DB_HOST_PATTERNS)


def _db_deployment_replicas(docs: list[dict[str, Any]]) -> int | None:
    for d in docs:
        if d.get("kind") != "Deployment":
            continue
        if (d.get("metadata") or {}).get("name") == "db-deployment":
            return int((d.get("spec") or {}).get("replicas") or 0)
    return None


def _iter_container_env(docs: list[dict[str, Any]]):
    for d in docs:
        if d.get("kind") != "Deployment":
            continue
        dn = d["metadata"]["name"]
        for c in (d.get("spec") or {}).get("template", {}).get("spec", {}).get(
            "containers"
        ) or []:
            for e in c.get("env") or []:
                yield dn, e


def validate_docs(
    docs: list[dict[str, Any]], label: str, environment: str | None = None
) -> bool:
    ok = True
    env = (environment or "").strip().lower() or None
    deploys = [d for d in docs if d.get("kind") == "Deployment"]
    cms = {
        d["metadata"]["name"]: set((d.get("data") or {}))
        for d in docs
        if d.get("kind") == "ConfigMap"
    }

    producers: dict[str, list[tuple[str, set[str], dict[str, Any]]]] = defaultdict(list)
    for d in docs:
        target = _secret_target_name(d)
        if not target:
            continue
        kind = d.get("kind") or ""
        if kind in {"Secret", "SealedSecret", "ExternalSecret"}:
            producers[target].append((kind, _producer_keys(d), d))

    for name, owners in producers.items():
        kinds = [k for k, _, _ in owners]
        if len(owners) > 1:
            print(
                f"FAIL {label}: Duplicate ownership for Secret {name} "
                f"(producers={kinds})"
            )
            ok = False

    for d in deploys:
        dn = d["metadata"]["name"]
        spec = d.get("spec") or {}
        sel = (spec.get("selector") or {}).get("matchLabels") or {}
        tpl = ((spec.get("template") or {}).get("metadata") or {}).get("labels") or {}
        for k, v in sel.items():
            if tpl.get(k) != v:
                print(f"FAIL {label}/{dn} selector {k}={v} vs pod {tpl.get(k)}")
                ok = False
        if dn == "celery-beat-deployment" and int(spec.get("replicas") or 0) != 1:
            print(f"FAIL {label} beat replicas={spec.get('replicas')}")
            ok = False
        for c in (spec.get("template") or {}).get("spec", {}).get("containers") or []:
            env_names = [e.get("name") for e in (c.get("env") or []) if e.get("name")]
            dup = [n for n, cnt in Counter(env_names).items() if cnt > 1]
            if dup:
                print(f"FAIL {label}/{dn}/{c.get('name')} dup env {dup}")
                ok = False
            ports = [p.get("containerPort") for p in (c.get("ports") or [])]
            if len(ports) != len(set(ports)):
                print(f"FAIL {label}/{dn} dup ports {ports}")
                ok = False
            for e in c.get("env") or []:
                vf = e.get("valueFrom") or {}
                cm = vf.get("configMapKeyRef") or {}
                sk = vf.get("secretKeyRef") or {}
                if cm:
                    cname, ckey = cm.get("name"), cm.get("key")
                    if cname not in cms:
                        print(f"FAIL {label}/{dn} missing ConfigMap {cname}")
                        ok = False
                    elif ckey not in cms[cname]:
                        print(f"FAIL {label}/{dn} missing ConfigMap key {cname}/{ckey}")
                        ok = False
                if sk:
                    sname, skey = sk.get("name"), sk.get("key")
                    owners = producers.get(sname or "", [])
                    if not owners:
                        print(
                            f"FAIL {label}/{dn} missing Secret producer for "
                            f"{sname}/{skey}"
                        )
                        ok = False
                        continue
                    key_ok = any(skey in keys or "*" in keys for _, keys, _ in owners)
                    if not key_ok:
                        print(
                            f"FAIL {label}/{dn} missing Secret key {sname}/{skey} "
                            f"in producers {[k for k, _, _ in owners]}"
                        )
                        ok = False

    # App sealed-secret required keys
    for name, owners in producers.items():
        if name != "audiomind-secrets":
            continue
        for kind, keys, doc in owners:
            if kind == "SealedSecret":
                for required in ("JWT_SECRET", "INTERNAL_SERVICE_TOKEN", "GEMINI_API_KEY"):
                    if required not in keys:
                        print(
                            f"FAIL {label}: SealedSecret audiomind-secrets missing "
                            f"encryptedData.{required}"
                        )
                        ok = False
            if kind == "Secret":
                jwt = (doc.get("stringData") or {}).get("JWT_SECRET")
                if jwt is not None:
                    reason = _is_bad_jwt_plaintext(str(jwt))
                    if reason:
                        print(f"FAIL {label}: Secret {name} JWT_SECRET {reason}")
                        ok = False

    # Database secret required keys
    db_owners = producers.get("audiomind-db-secrets", [])
    if not db_owners and env in {"dev", "staging", "prod"}:
        print(f"FAIL {label}: missing audiomind-db-secrets producer")
        ok = False
    for kind, keys, doc in db_owners:
        required = {
            "MEETING_DATABASE_URL",
            "USER_DATABASE_URL",
            "AI_DATABASE_URL",
            "DB_USERNAME",
            "DB_PASSWORD",
        }
        missing = required - keys
        if missing and "*" not in keys:
            print(f"FAIL {label}: audiomind-db-secrets missing keys {sorted(missing)}")
            ok = False
        if kind == "Secret":
            sd = doc.get("stringData") or {}
            for key, value in sd.items():
                if _contains_db_placeholder(str(value)):
                    print(
                        f"FAIL {label}: Secret audiomind-db-secrets key {key} "
                        f"contains managed-DB placeholder"
                    )
                    ok = False
            meeting = str(sd.get("MEETING_DATABASE_URL") or "")
            user = str(sd.get("USER_DATABASE_URL") or "")
            ai = str(sd.get("AI_DATABASE_URL") or "")
            if meeting and not meeting.startswith("jdbc:postgresql://"):
                print(f"FAIL {label}: MEETING_DATABASE_URL must be jdbc:postgresql://")
                ok = False
            if user and not user.startswith("jdbc:postgresql://"):
                print(f"FAIL {label}: USER_DATABASE_URL must be jdbc:postgresql://")
                ok = False
            if ai and not (
                ai.startswith("postgresql://")
                or ai.startswith("postgresql+psycopg://")
                or ai.startswith("postgresql+asyncpg://")
            ):
                print(
                    f"FAIL {label}: AI_DATABASE_URL must be SQLAlchemy postgresql scheme"
                )
                ok = False
            if ai.startswith("jdbc:"):
                print(f"FAIL {label}: AI_DATABASE_URL must not be JDBC")
                ok = False
        if kind == "SealedSecret":
            for key, value in ((doc.get("spec") or {}).get("encryptedData") or {}).items():
                text = str(value)
                if _contains_db_placeholder(text) and not text.startswith(
                    "REPLACE_WITH_SEALED_"
                ):
                    print(
                        f"FAIL {label}: SealedSecret audiomind-db-secrets "
                        f"encryptedData.{key} looks like plaintext placeholder"
                    )
                    ok = False

    # Staging/prod must not render raw placeholder Secrets for DB
    if env in {"staging", "prod"}:
        for d in docs:
            if d.get("kind") != "Secret":
                continue
            name = (d.get("metadata") or {}).get("name")
            blob = yaml.safe_dump(d)
            if _contains_db_placeholder(blob):
                print(f"FAIL {label}: raw Secret {name} contains DB placeholder text")
                ok = False
            if name in {"db-creds", "audiomind-db-secrets"}:
                # Only SealedSecret should produce audiomind-db-secrets in staging/prod
                if name == "audiomind-db-secrets":
                    print(
                        f"FAIL {label}: raw Secret audiomind-db-secrets must not "
                        f"render in {env}"
                    )
                    ok = False
                if name == "db-creds":
                    print(f"FAIL {label}: legacy Secret db-creds must not render in {env}")
                    ok = False

    # Internal DB disabled guard
    replicas = _db_deployment_replicas(docs)
    internal_disabled = replicas == 0 or (
        env in {"staging", "prod"} and replicas is None
    )
    if env == "dev" and (replicas is None or replicas < 1):
        print(f"FAIL {label}: dev overlay must keep internal db-deployment replicas>=1")
        ok = False
    if internal_disabled and env in {"staging", "prod"}:
        for dn, e in _iter_container_env(docs):
            literal = e.get("value")
            if literal and _contains_internal_db_host(str(literal)):
                print(
                    f"FAIL {label}/{dn}: env {e.get('name')} points at internal DB "
                    f"while db-deployment disabled: {literal}"
                )
                ok = False
            # Resolved secret stringData already checked; sealed placeholders OK

        # Ensure DB-using deployments reference audiomind-db-secrets (not audiomind-secrets)
        for d in deploys:
            dn = d["metadata"]["name"]
            for c in (d.get("spec") or {}).get("template", {}).get("spec", {}).get(
                "containers"
            ) or []:
                for e in c.get("env") or []:
                    if e.get("name") not in _DB_ENV_NAMES and e.get("name") not in {
                        "SPRING_DATASOURCE_USERNAME",
                        "SPRING_DATASOURCE_PASSWORD",
                    }:
                        continue
                    sk = ((e.get("valueFrom") or {}).get("secretKeyRef") or {})
                    if not sk:
                        continue
                    if sk.get("name") != "audiomind-db-secrets":
                        print(
                            f"FAIL {label}/{dn}: database env {e.get('name')} must "
                            f"use audiomind-db-secrets, got {sk.get('name')}"
                        )
                        ok = False

    # Beat schedules only — must not set DATABASE_URL in any environment
    for d in deploys:
        if (d.get("metadata") or {}).get("name") != "celery-beat-deployment":
            continue
        for c in (d.get("spec") or {}).get("template", {}).get("spec", {}).get(
            "containers"
        ) or []:
            for e in c.get("env") or []:
                if e.get("name") == "DATABASE_URL":
                    print(
                        f"FAIL {label}: celery-beat must not set DATABASE_URL "
                        f"(schedules only; workers own DB access)"
                    )
                    ok = False

    print(f"{label}: docs={len(docs)} deployments={len(deploys)} ok={ok}")
    return ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", help="Rendered YAML file(s)")
    parser.add_argument(
        "--environment",
        choices=("dev", "staging", "prod"),
        help="Enable environment-specific managed-DB guards",
    )
    args = parser.parse_args(argv)
    if args.files:
        paths = [Path(p) for p in args.files]
    else:
        paths = [ROOT / f"rendered-{name}.yaml" for name in ("dev", "staging", "prod")]
    ok = True
    for path in paths:
        if not path.exists():
            print(f"FAIL missing {path}")
            return 1
        env = args.environment
        if env is None:
            stem = path.stem
            for candidate in ("dev", "staging", "prod"):
                if candidate in stem:
                    env = candidate
                    break
        if not validate_docs(_load_docs(path), path.stem, env):
            ok = False
    print("structural_k8s_validate:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
