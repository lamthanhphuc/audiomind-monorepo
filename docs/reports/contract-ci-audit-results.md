# Contract & CI Audit Results

- Date: 2026-05-28
- Branch: `chore/contract-ci-hardening-spec`

## CI inventory

- `CI` workflow:
  - `build-test`
  - `contract-check`
  - `commit-check`
- `Contract Check` workflow:
  - `contract`
- `security-recheck` workflow:
  - `recheck`
- `CI/CD Pipeline` workflow:
  - `build`
  - `test`
  - `prepare-matrix`
  - `build-and-push`
- `Smoke Test E2E` workflow:
  - `smoke-test`
- `CI Auto-Fix Loop` workflow:
  - `run-loop`
- `Docker Build Push Legacy` workflow:
  - `docker-build-push`

## Contract inventory

- OpenAPI source of truth:
  - `packages/contracts/meeting-api.yaml`
  - `packages/contracts/processing-api.yaml`
  - `packages/contracts/ai-api.yaml`
- JSON schema artifacts:
  - `packages/contracts/config.schema.json`
  - `packages/contracts/error.schema.json`
  - `packages/contracts/ai-step.schema.json`
- Protobuf artifacts:
  - `packages/contracts/ai-stream.proto`
  - `packages/contracts/realtime-events.proto`
- Generated FE client artifacts:
  - `packages/api-clients/ai.ts`
  - `packages/api-clients/meeting.ts`
  - `packages/api-clients/processing.ts`
- Supporting validation scripts:
  - `packages/tooling/config-validation/validate-schemas.mjs`
  - `infra/scripts/check-openapi-main.mjs`
  - `scripts/ci-fix/repro-contract-check.ps1`

## Known risks

- Required check skip risk from path-filtered contract workflow.
- Duplicate contract validation surfaces can confuse branch protection and release triage.
- Generated client drift can occur if generation and diff checking are not kept together.
- Protobuf contracts exist, but no explicit validation command surfaced in the current scripts.
- `security-recheck` contains intentional skip/soft-fail behavior, so it should not be treated as a strict contract gate.
- Branch protection API was not readable with the current token, so required checks could not be confirmed directly.

## Recommended implementation order

1. Confirm branch protection and the real required check names using a token that can read protection settings.
2. Align the contract validation command set between local repro and CI.
3. Tighten the client drift check so generated artifacts are always diffed after generation.
4. Review workflow triggers for path filters and skipped required checks.
5. Re-run full CI only after the implementation phase.

## Open questions

- Which checks are required on the repository right now?
- Should the standalone `Contract Check` workflow remain separate from the `CI` contract job?
- Is there a canonical validation command for the protobuf contracts?
- Should docs-only PRs be exempt from contract-only checks?

## PR #65 precondition verification

- Command executed: `gh pr view 65 --json number,state,mergeStateStatus,headRefName,baseRefName,statusCheckRollup,url`
- Command executed: `gh pr checks 65`
- Result: PR #65 is `MERGED`.
- Result: the visible checks were all successful.
- Result: `build-test`, `contract-check`, `commit-check`, and `security-recheck` completed successfully.

## Branch protection verification

- Attempted: `gh api repos/lamthanhphuc/audiomind-monorepo/branches/main/protection`
- Result: HTTP 403 from GitHub for the current PAT.
- Interpretation: branch protection requirements could not be confirmed directly from the API.
- Manual fallback: inspect required checks in the GitHub UI or use a token with the needed read access.

## Evidence / commands executed

- `codegraph status`
- `codegraph context "Phase 7I Contract CI Hardening spec audit PR65 precondition branch protection required checks"`
- `codegraph query "Contract CI hardening PR65 branch protection required checks workflow path filter generated client drift"`
- `codegraph affected`
- `git ls-files ".github/workflows/*"`
- `git ls-files "*openapi*" "*swagger*" "*contract*" "*schema*"`
- `git ls-files "package.json" "FE-Audiomind/package.json" "demoRecordAUDIOMID/pom.xml"`
- `git ls-files "packages/api-clients/*"`
- `git ls-files "packages/contracts/*"`
- `gh auth status`
- `gh pr view 65 --json number,state,mergeStateStatus,headRefName,baseRefName,statusCheckRollup,url`
- `gh pr checks 65`
- `gh api repos/lamthanhphuc/audiomind-monorepo/branches/main/protection`
- `git diff -- docs/specs/contract-ci-hardening.md docs/reports/contract-ci-audit-results.md`
- `git diff --stat`
- `git diff --name-only`
- `git status --short --untracked-files=all`
