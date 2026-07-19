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
_STT_WIRED_DEPLOYMENTS = {
    "ai-api-deployment",
    "celery-worker-deployment",
}
_IMMUTABLE_IMAGE_SUFFIX = ":0.1.0"
_STAGING_NAMESPACE = "audiomind-staging"


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


def _deployment_env_map(docs: list[dict[str, Any]], deployment_name: str) -> dict[str, Any]:
    for d in docs:
        if d.get("kind") != "Deployment":
            continue
        if (d.get("metadata") or {}).get("name") != deployment_name:
            continue
        env_map: dict[str, Any] = {}
        for c in (d.get("spec") or {}).get("template", {}).get("spec", {}).get(
            "containers"
        ) or []:
            for e in c.get("env") or []:
                name = e.get("name")
                if name:
                    env_map[str(name)] = e
        return env_map
    return {}


def _configmap_value(cms: dict[str, set[str]], docs: list[dict[str, Any]], key: str) -> str | None:
    if "audiomind-config" in cms and key in cms["audiomind-config"]:
        for d in docs:
            if d.get("kind") != "ConfigMap":
                continue
            if (d.get("metadata") or {}).get("name") != "audiomind-config":
                continue
            value = (d.get("data") or {}).get(key)
            if value is not None:
                return str(value)
    return None


def validate_docs(
    docs: list[dict[str, Any]],
    label: str,
    environment: str | None = None,
    *,
    deploy_ready: bool = False,
    code_only: bool = False,
    require_immutable_images: bool = False,
) -> bool:
    ok = True
    env = (environment or "").strip().lower() or None
    deploys = [d for d in docs if d.get("kind") == "Deployment"]
    cms = {
        d["metadata"]["name"]: set((d.get("data") or {}))
        for d in docs
        if d.get("kind") == "ConfigMap"
    }

    immutable_gate = deploy_ready or require_immutable_images
    if env in {"staging", "prod"}:
        deploy_names = {(d.get("metadata") or {}).get("name") for d in deploys}
        if "frontend-deployment" not in deploy_names:
            print(f"FAIL {label}: {env} must render frontend-deployment")
            ok = False

        if env == "staging":
            for d in docs:
                meta = d.get("metadata") or {}
                ns = meta.get("namespace")
                if ns and ns != _STAGING_NAMESPACE:
                    print(
                        f"FAIL {label}: staging resource {meta.get('name')} "
                        f"namespace={ns} expected {_STAGING_NAMESPACE}"
                    )
                    ok = False

        for dn in _STT_WIRED_DEPLOYMENTS:
            env_map = _deployment_env_map(docs, dn)
            stt_env = env_map.get("STT_PROVIDER")
            if not stt_env:
                print(f"FAIL {label}/{dn}: missing STT_PROVIDER env")
                ok = False
                continue
            cm_ref = ((stt_env.get("valueFrom") or {}).get("configMapKeyRef") or {})
            if cm_ref.get("name") != "audiomind-config" or cm_ref.get("key") != "STT_PROVIDER":
                print(f"FAIL {label}/{dn}: STT_PROVIDER must come from audiomind-config/STT_PROVIDER")
                ok = False
            if "STT_PROVIDER" not in cms.get("audiomind-config", set()):
                print(f"FAIL {label}: audiomind-config missing STT_PROVIDER key")
                ok = False

        if immutable_gate:
            for d in deploys:
                dn = (d.get("metadata") or {}).get("name") or "deployment"
                for c in (d.get("spec") or {}).get("template", {}).get("spec", {}).get(
                    "containers"
                ) or []:
                    image = str(c.get("image") or "")
                    if image.endswith(_IMMUTABLE_IMAGE_SUFFIX):
                        print(
                            f"FAIL {label}/{dn}: image {image} uses forbidden "
                            f"placeholder tag {_IMMUTABLE_IMAGE_SUFFIX}"
                        )
                        ok = False

    # Never allow REPLACE_WITH_SEALED / CHANGE_ME in rendered staging/prod.
    if env in {"staging", "prod"}:
        blob = yaml.safe_dump_all(docs)
        for token in (
            "REPLACE_WITH_SEALED",
            "REPLACE_ME",
            "CHANGE_ME",
            "your-managed-db-host",
            "your_username",
            "your_password",
        ):
            if token in blob:
                print(f"FAIL {label}: rendered {env} contains forbidden token {token}")
                ok = False

    # postgres-data-pvc is dev-only
    pvc_names = {
        (d.get("metadata") or {}).get("name")
        for d in docs
        if d.get("kind") == "PersistentVolumeClaim"
    }
    if env == "dev" and "postgres-data-pvc" not in pvc_names:
        print(f"FAIL {label}: dev must render postgres-data-pvc")
        ok = False
    if env in {"staging", "prod"} and "postgres-data-pvc" in pvc_names:
        print(f"FAIL {label}: postgres-data-pvc must not render in {env}")
        ok = False

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

    require_secret_producers = not code_only or env == "dev" or deploy_ready

    if env in {"staging", "prod"}:
        diarization_value = (
            _configmap_value(cms, docs, "ENABLE_SPEAKER_DIARIZATION") or ""
        ).lower()
        hf_owners = producers.get("audiomind-secrets", [])
        hf_key_present = any(
            "HUGGINGFACE_TOKEN" in keys or "*" in keys for _, keys, _ in hf_owners
        )
        if diarization_value == "true" and require_secret_producers and not hf_key_present:
            print(
                f"FAIL {label}: ENABLE_SPEAKER_DIARIZATION=true requires "
                f"HUGGINGFACE_TOKEN in audiomind-secrets producer"
            )
            ok = False
        elif diarization_value != "true" and require_secret_producers and not hf_key_present:
            print(
                f"WARN {label}: diarization disabled but audiomind-secrets lacks "
                f"HUGGINGFACE_TOKEN (workloads still reference the key)"
            )

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
            # Core APIs must expose readiness + liveness (+ startup for Java/AI APIs)
            if dn in {
                "meeting-api-deployment",
                "user-api-deployment",
                "processing-api-deployment",
                "ai-api-deployment",
            }:
                if not c.get("readinessProbe"):
                    print(f"FAIL {label}/{dn}: missing readinessProbe")
                    ok = False
                if not c.get("livenessProbe"):
                    print(f"FAIL {label}/{dn}: missing livenessProbe")
                    ok = False
                if not c.get("startupProbe"):
                    print(f"FAIL {label}/{dn}: missing startupProbe")
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
                if sk and require_secret_producers:
                    sname, skey = sk.get("name"), sk.get("key")
                    optional_ref = sk.get("optional") in (True, "true", "True")
                    owners = producers.get(sname or "", [])
                    if not owners:
                        if optional_ref:
                            continue
                        print(
                            f"FAIL {label}/{dn} missing Secret producer for "
                            f"{sname}/{skey}"
                        )
                        ok = False
                        continue
                    key_ok = any(skey in keys or "*" in keys for _, keys, _ in owners)
                    if not key_ok and not optional_ref:
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
                for required in (
                    "JWT_SECRET",
                    "INTERNAL_SERVICE_TOKEN",
                    "GEMINI_API_KEY",
                    "HUGGINGFACE_TOKEN",
                ):
                    if required not in keys:
                        print(
                            f"FAIL {label}: SealedSecret audiomind-secrets missing "
                            f"encryptedData.{required}"
                        )
                        ok = False
                if deploy_ready:
                    for key, value in ((doc.get("spec") or {}).get("encryptedData") or {}).items():
                        if str(value).startswith("REPLACE_WITH_SEALED"):
                            print(
                                f"FAIL {label}: deploy-ready requires real ciphertext "
                                f"for audiomind-secrets/{key}"
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
    if not db_owners and env == "dev":
        print(f"FAIL {label}: missing audiomind-db-secrets producer")
        ok = False
    if not db_owners and deploy_ready and env in {"staging", "prod"}:
        print(
            f"FAIL {label}: deploy-ready requires audiomind-db-secrets producer "
            f"(apply sealed-db-secret.yaml from generate-sealed-secrets)"
        )
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
                ai.startswith("postgresql://") or ai.startswith("postgresql+psycopg2://")
            ):
                print(
                    f"FAIL {label}: AI_DATABASE_URL must be postgresql:// or "
                    f"postgresql+psycopg2:// (psycopg2 runtime)"
                )
                ok = False
            if ai.startswith("jdbc:") or ai.startswith("postgresql+psycopg://") or ai.startswith(
                "postgresql+asyncpg://"
            ):
                print(f"FAIL {label}: AI_DATABASE_URL incompatible with psycopg2 runtime")
                ok = False
            if env in {"staging", "prod"}:
                for label_url, url in (("MEETING", meeting), ("USER", user), ("AI", ai)):
                    lowered = url.lower()
                    if url and "sslmode=require" not in lowered and "sslmode=verify-full" not in lowered:
                        print(
                            f"FAIL {label}: {label_url}_DATABASE_URL must include "
                            f"sslmode=require or verify-full in {env}"
                        )
                        ok = False
        if kind == "SealedSecret":
            for key, value in ((doc.get("spec") or {}).get("encryptedData") or {}).items():
                text = str(value)
                if text.startswith("REPLACE_WITH_SEALED") and (
                    deploy_ready or env in {"staging", "prod"}
                ):
                    print(
                        f"FAIL {label}: SealedSecret audiomind-db-secrets "
                        f"encryptedData.{key} is still a REPLACE_WITH_SEALED placeholder"
                    )
                    ok = False
                if _contains_db_placeholder(text):
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

        # Migration jobs must exist for ordered rollout
        job_names = {
            (d.get("metadata") or {}).get("name")
            for d in docs
            if d.get("kind") == "Job"
        }
        for required_job in ("user-db-migrate", "meeting-db-migrate", "ai-db-migrate"):
            if required_job not in job_names:
                print(f"FAIL {label}: missing migration Job {required_job}")
                ok = False

        # Meeting must wait for app_users
        meeting = next(
            (d for d in deploys if (d.get("metadata") or {}).get("name") == "meeting-api-deployment"),
            None,
        )
        if meeting:
            inits = (
                (meeting.get("spec") or {})
                .get("template", {})
                .get("spec", {})
                .get("initContainers")
                or []
            )
            if not any(c.get("name") == "wait-user-schema" for c in inits):
                print(f"FAIL {label}: meeting-api missing wait-user-schema initContainer")
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

    print(
        f"{label}: docs={len(docs)} deployments={len(deploys)} "
        f"deploy_ready={deploy_ready} code_only={code_only} ok={ok}"
    )
    return ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", help="Rendered YAML file(s)")
    parser.add_argument(
        "--environment",
        choices=("dev", "staging", "prod"),
        help="Enable environment-specific managed-DB guards",
    )
    parser.add_argument(
        "--deploy-ready",
        action="store_true",
        help="Require real SealedSecret ciphertext and secret producers (staging deploy gate)",
    )
    parser.add_argument(
        "--code-only",
        action="store_true",
        help="Merge-CI mode: allow missing sealed secret producers in staging/prod",
    )
    parser.add_argument(
        "--require-immutable-images",
        action="store_true",
        help="Reject placeholder :0.1.0 image tags (CI after image patch simulation)",
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
        code_only = args.code_only
        if env in {"staging", "prod"} and not args.deploy_ready:
            code_only = True
        if not validate_docs(
            _load_docs(path),
            path.stem,
            env,
            deploy_ready=args.deploy_ready,
            code_only=code_only,
            require_immutable_images=args.require_immutable_images,
        ):
            ok = False
    print("structural_k8s_validate:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
