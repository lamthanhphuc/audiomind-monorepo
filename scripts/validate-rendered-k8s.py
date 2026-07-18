#!/usr/bin/env python3
"""Offline structural validation for kubectl-kustomize rendered overlays.

Fails when:
- Deployment selector/labels mismatch, duplicate env/ports
- ConfigMap key refs missing
- Secret/SealedSecret/ExternalSecret producer missing for a secretKeyRef
- Duplicate ownership of the same Secret name (raw Secret + SealedSecret)
- Beat replicas != 1
- SealedSecret audiomind-secrets missing required encryptedData keys
- Raw Secret JWT_SECRET placeholder/short
"""

from __future__ import annotations

import argparse
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


def validate_docs(docs: list[dict[str, Any]], label: str) -> bool:
    ok = True
    deploys = [d for d in docs if d.get("kind") == "Deployment"]
    cms = {
        d["metadata"]["name"]: set((d.get("data") or {}))
        for d in docs
        if d.get("kind") == "ConfigMap"
    }

    producers: dict[str, list[tuple[str, set[str]]]] = defaultdict(list)
    for d in docs:
        target = _secret_target_name(d)
        if not target:
            continue
        kind = d.get("kind") or ""
        if kind in {"Secret", "SealedSecret", "ExternalSecret"}:
            producers[target].append((kind, _producer_keys(d)))

    for name, owners in producers.items():
        kinds = [k for k, _ in owners]
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
                    key_ok = any(skey in keys or "*" in keys for _, keys in owners)
                    if not key_ok:
                        print(
                            f"FAIL {label}/{dn} missing Secret key {sname}/{skey} "
                            f"in producers {[k for k, _ in owners]}"
                        )
                        ok = False

    for name, owners in producers.items():
        if name != "audiomind-secrets":
            continue
        for kind, keys in owners:
            if kind == "SealedSecret":
                for required in ("JWT_SECRET", "INTERNAL_SERVICE_TOKEN", "GEMINI_API_KEY"):
                    if required not in keys:
                        print(
                            f"FAIL {label}: SealedSecret audiomind-secrets missing "
                            f"encryptedData.{required}"
                        )
                        ok = False
            if kind == "Secret":
                for doc in docs:
                    if doc.get("kind") != "Secret":
                        continue
                    if (doc.get("metadata") or {}).get("name") != name:
                        continue
                    jwt = (doc.get("stringData") or {}).get("JWT_SECRET")
                    if jwt is None:
                        continue
                    reason = _is_bad_jwt_plaintext(str(jwt))
                    if reason:
                        print(f"FAIL {label}: Secret {name} JWT_SECRET {reason}")
                        ok = False

    print(f"{label}: docs={len(docs)} deployments={len(deploys)} ok={ok}")
    return ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "files",
        nargs="*",
        help="Rendered YAML files (default: rendered-{dev,staging,prod}.yaml)",
    )
    args = parser.parse_args(argv)
    paths = (
        [Path(p) for p in args.files]
        if args.files
        else [ROOT / f"rendered-{name}.yaml" for name in ("dev", "staging", "prod")]
    )
    ok = True
    for path in paths:
        if not path.exists():
            print(f"FAIL missing {path}")
            return 1
        if not validate_docs(_load_docs(path), path.stem):
            ok = False
    print("structural_k8s_validate:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
