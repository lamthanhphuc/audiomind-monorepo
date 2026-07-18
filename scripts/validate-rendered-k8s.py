#!/usr/bin/env python3
"""Offline structural validation for kubectl-kustomize rendered overlays.

Used when kubectl client dry-run still requires a live API server / CRD discovery.
Checks selectors, duplicate env/ports, ConfigMap key refs, Beat replicas=1.
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    ok = True
    for name in ("dev", "staging", "prod"):
        path = ROOT / f"rendered-{name}.yaml"
        if not path.exists():
            print(f"FAIL missing {path}")
            return 1
        docs = [d for d in yaml.safe_load_all(path.read_text(encoding="utf-8")) if d]
        deploys = [d for d in docs if d.get("kind") == "Deployment"]
        cms = {
            d["metadata"]["name"]: set((d.get("data") or {}))
            for d in docs
            if d.get("kind") == "ConfigMap"
        }
        secs = {
            d["metadata"]["name"]: set(d.get("stringData") or {})
            | set(d.get("data") or {})
            for d in docs
            if d.get("kind") == "Secret"
        }
        for d in deploys:
            dn = d["metadata"]["name"]
            spec = d.get("spec") or {}
            sel = (spec.get("selector") or {}).get("matchLabels") or {}
            tpl = ((spec.get("template") or {}).get("metadata") or {}).get("labels") or {}
            for k, v in sel.items():
                if tpl.get(k) != v:
                    print(f"FAIL {name}/{dn} selector {k}={v} vs pod {tpl.get(k)}")
                    ok = False
            if dn == "celery-beat-deployment" and int(spec.get("replicas") or 0) != 1:
                print(f"FAIL {name} beat replicas={spec.get('replicas')}")
                ok = False
            for c in (spec.get("template") or {}).get("spec", {}).get("containers") or []:
                env_names = [
                    e.get("name") for e in (c.get("env") or []) if e.get("name")
                ]
                dup = [n for n, cnt in Counter(env_names).items() if cnt > 1]
                if dup:
                    print(f"FAIL {name}/{dn}/{c.get('name')} dup env {dup}")
                    ok = False
                ports = [p.get("containerPort") for p in (c.get("ports") or [])]
                if len(ports) != len(set(ports)):
                    print(f"FAIL {name}/{dn} dup ports {ports}")
                    ok = False
                for e in c.get("env") or []:
                    vf = e.get("valueFrom") or {}
                    cm = vf.get("configMapKeyRef") or {}
                    sk = vf.get("secretKeyRef") or {}
                    if cm:
                        cname, ckey = cm.get("name"), cm.get("key")
                        if cname not in cms:
                            print(f"FAIL {name}/{dn} missing ConfigMap {cname}")
                            ok = False
                        elif ckey not in cms[cname]:
                            print(f"FAIL {name}/{dn} missing ConfigMap key {cname}/{ckey}")
                            ok = False
                    if sk:
                        sname, skey = sk.get("name"), sk.get("key")
                        if sname not in secs:
                            # SealedSecret overlays may omit raw Secret data keys.
                            print(f"INFO {name}/{dn} secret {sname} not inline in render")
                        elif skey and skey not in secs[sname]:
                            print(f"FAIL {name}/{dn} missing Secret key {sname}/{skey}")
                            ok = False
        print(f"{name}: docs={len(docs)} deployments={len(deploys)}")
    print("structural_k8s_validate:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
