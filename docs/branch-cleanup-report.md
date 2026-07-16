# Branch cleanup report — Stage A (audit only)

**Date:** 2026-07-15  
**Repository:** lamthanhphuc/audiomind-monorepo  
**Base at audit:** `origin/main` @ `d77a030` (Feature/audio recording quality #121)  
**Feature branch created:** `feature/phase1-subject-education`  
**Stage:** A — audit only. **No deletions, no archive tags, no pushes.**

## Kept (required)

| Branch | Notes |
|--------|--------|
| `main` | Primary branch; tracks `origin/main` |
| `feature/phase1-subject-education` | Phase 1 implementation branch (created from `main`) |

## Local branches (proposed for Stage B — awaiting user approval)

| Branch | Merged into `main`? | Open PR | Proposed action |
|--------|---------------------|---------|-----------------|
| `backup/audio-recording-quality-before-rewrite-20260715` | N/A (backup) | No | **Proposed delete (local)** after user confirms backup no longer needed |
| `feature/fe-update` | Unknown without per-branch check | No | **Proposed delete (local)** if merged or obsolete — user approval required |
| `feature/new-user-premium-trial` | Unknown | No | **Proposed delete (local)** if merged or obsolete — user approval required |
| `fix/mobile-dashboard-sidebar` | Likely merged via PR #120 | No | **Proposed delete (local)** if ancestor of `main` — user approval required |

## Remote branches (proposed for Stage B — awaiting user approval)

After `git fetch --all --prune`, only `origin/main` remains on remote.

| Remote | Proposed action |
|--------|-----------------|
| `origin/main` | **Keep** (protected primary) |

Previously observed remotes (now pruned or removed upstream): `feat/public-legal-pages`, `feature/audio-recording-quality`, `function-GGlogin-and-payment` — no longer listed after prune.

## Unmerged / archive tags

| Item | Status |
|------|--------|
| Archive tags | **None created** (Stage A) |
| Unmerged branch archive plan | Pending Stage B user approval per branch |

## Open pull requests

None (`gh pr list --state open` → empty).

## Protected / permission blocked

Not evaluated against GitHub protected-branch API in this audit. `origin/main` treated as protected by policy.

## Working tree at Stage A

- Untracked: `docs/phase1-subject-education-plan.md` (added to feature branch in first docs commit)
- No stash required (clean aside from plan doc)

## Working tree after Phase 1 FE integration (2026-07-16)

- Branch: `feature/phase1-subject-education`
- Latest commits include OpenAPI/contracts, FE study workspace, education panel, tests
- Working tree: clean after `c86a19d`
- Stage B: still **not performed**

## Stage B gate

**Do not delete any local or remote branch until the user explicitly approves this report's proposed-delete list.**

Unmerged branches require archive tag push to `origin` before deletion (per plan §3).
