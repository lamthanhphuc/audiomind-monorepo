# Beta Ops CI Scripts

Entry point: [docs/specs/beta-ops-gate/README.md](../../docs/specs/beta-ops-gate/README.md)

| Script | Purpose |
|--------|---------|
| [log-safety-scan.sh](./log-safety-scan.sh) | Forbidden patterns in logger calls |
| [log-safety-allowlist.txt](./log-safety-allowlist.txt) | Path/line exceptions |
| [verify-ready-staging.sh](./verify-ready-staging.sh) | K8s staging `/ready` gate |
| [log-bundle.sh](./log-bundle.sh) | BETA_OPS log grep bundle |

## Local usage

```bash
bash scripts/ci/log-safety-scan.sh
bash scripts/ci/verify-ready-staging.sh --dry-run
bash scripts/ci/log-bundle.sh --profile BETA_OPS --since 1h
```

## Drills

See [drills/run-drill.sh](./drills/run-drill.sh) and [beta-ops-gate-checklist.md](../../docs/specs/beta-ops-gate-checklist.md).
