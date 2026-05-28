# Phase 7I — Contract & CI Hardening

## 1. Status

- SPEC-ONLY
- Branch: `chore/contract-ci-hardening-spec`
- Date: 2026-05-28
- No code/workflow changes in this branch

## 2. Background

Phase 7B through 7G hardened health endpoints, canonical error responses, logging, analysis reliability, STT diagnostics, and realtime STT behavior. Phase 7H and 7J then added the backend demo debugging guide and the final demo checklist.

Phase 7I is separated because contract validation and CI hardening affect merge confidence, required checks, and release readiness without changing runtime behavior. This phase is especially sensitive because it intersects GitHub Actions, OpenAPI/schema validation, generated client drift, and branch protection rules.

The goal of this spec is to audit the current contract and CI surface, identify the main reliability risks, and define a small implementation plan for the next pass. This branch intentionally stops at planning and documentation.

## 3. Goals

- Ensure OpenAPI, schema, and generated-client validation is reliable.
- Ensure GitHub required checks pass consistently.
- Make local reproduce commands clear.
- Reduce false positives and flaky CI behavior.
- Keep check names stable.
- Avoid skipped or pending required checks.

## 4. Non-goals

- Do not change runtime API behavior.
- Do not rewrite CI from scratch.
- Do not remove required checks.
- Do not regenerate the client blindly.
- Do not modify FE behavior.
- Do not change security policy without evidence.

## 5. Current CI inventory

| Workflow | Jobs/checks | Trigger | Required? | Current risk | Notes |
| --- | --- | --- | --- | --- | --- |
| CI | `build-test` | `pull_request`, `push` to `main` | Unknown from current token | Long multi-language job can be hard to triage; it mixes build, lint, tests, and gated E2E | Main PR validation surface |
| CI | `contract-check` | `pull_request`, `push` to `main` | Unknown from current token | Duplicates the standalone contract workflow and may be confused with it in branch protection | Runs schema validation, OpenAPI diff, client generation, typecheck, drift check |
| CI | `commit-check` | `pull_request`, `push` to `main` | Unknown from current token | May be redundant if merge policy already enforces commit format elsewhere | Commitlint check |
| Contract Check | `contract` | `workflow_dispatch`, `push` to `production-ready`, `pull_request` paths `packages/contracts/**` | Unknown from current token | Path filter can leave a required check pending/skipped on unrelated PRs; separate workflow name from CI job name | Standalone contract workflow |
| security-recheck | `recheck` | `workflow_dispatch`, `push` to `production-ready`, `pull_request` to `main` or `master` | Likely not required for every PR | Some steps are intentionally non-blocking; NVD key gating can skip OWASP dependency-check | Heavy security workflow |
| CI/CD Pipeline | `build`, `test`, `prepare-matrix`, `build-and-push` | `workflow_dispatch`, `push` to `main` or `production-ready` | Not a PR-required surface | Branch/path filters and matrix generation make it a separate deployment path, not a contract check | Useful reference for release automation |
| Smoke Test E2E | `smoke-test` | `workflow_dispatch`, `push` to `main`, `master`, or `production-ready` | Not a PR-required surface | Secret-gated skip path means it may not execute in many environments | Auxiliary end-to-end smoke |
| CI Auto-Fix Loop | `run-loop` | `workflow_dispatch`, `schedule` | Not a PR-required surface | Operational automation, not a validation check | Keep separate from PR gating |
| Docker Build Push Legacy | `docker-build-push` | `workflow_dispatch` | Not a PR-required surface | Manual only; not part of merge gating | Legacy release helper |

## 6. Current contract/schema inventory

| Artifact | Path | Owner | Validation command | CI coverage | Risk |
| --- | --- | --- | --- | --- | --- |
| OpenAPI source of truth | `packages/contracts/meeting-api.yaml` | Contract repo | `npm run check:openapi` and `npm run generate:client` | Yes | Breakage here can drift the generated FE client |
| OpenAPI source of truth | `packages/contracts/processing-api.yaml` | Contract repo | `npm run check:openapi` and `npm run generate:client` | Yes | Same as above |
| OpenAPI source of truth | `packages/contracts/ai-api.yaml` | Contract repo | `npm run check:openapi` and `npm run generate:client` | Yes | Same as above |
| JSON schema | `packages/contracts/config.schema.json` | Contract repo | `npm run validate:schema` | Yes | Schema validation exists, but it is only as strong as the scripts using it |
| JSON schema | `packages/contracts/error.schema.json` | Contract repo | `npm run validate:schema` | Yes | Errors are validated, but workflow consistency still needs hardening |
| JSON schema | `packages/contracts/ai-step.schema.json` | Contract repo | `npm run validate:schema` | Yes | Same as above |
| Protobuf contract | `packages/contracts/ai-stream.proto` | Contract repo | No dedicated command found in current audit | Partial / unclear | Contract exists, but no explicit local or CI validation surfaced in the current scripts |
| Protobuf contract | `packages/contracts/realtime-events.proto` | Contract repo | No dedicated command found in current audit | Partial / unclear | Same as above |
| Generated FE client | `packages/api-clients/meeting.ts` | Generated artifact | `npm run generate:client`, `npx tsc --noEmit -p tsconfig.generated.json`, `git diff --exit-code` | Yes | Drift can be introduced if generation is not checked in the same step |
| Generated FE client | `packages/api-clients/processing.ts` | Generated artifact | Same as above | Yes | Same as above |
| Generated FE client | `packages/api-clients/ai.ts` | Generated artifact | Same as above | Yes | Same as above |

The FE runtime imports the generated clients directly from `packages/api-clients` in `FE-Audiomind/src/services/api.ts`, so contract drift can surface as type mismatches or runtime API mismatches if generation and diff checking are not kept aligned.

## 7. Local reproduce commands

FE:

- `npm --prefix FE-Audiomind run test`
- `npm --prefix FE-Audiomind run build`

Python:

- `python -m pytest -q demoRecordAUDIOMID/ai-service/tests`
- `ruff check demoRecordAUDIOMID/ai-service`
- `black --check demoRecordAUDIOMID/ai-service`

Java:

- `cd demoRecordAUDIOMID`
- `.\\mvnw.cmd -B test --no-transfer-progress`

Contract:

- `npm run validate:schema`
- `npm run check:openapi`
- `npm run generate:client`
- `npx tsc --noEmit -p tsconfig.generated.json`
- `powershell -ExecutionPolicy Bypass -File scripts/ci-fix/repro-contract-check.ps1`

CI:

- `gh pr checks`
- `gh run list --branch <branch> --limit 10`
- `gh run view <RUN_ID> --log-failed`

## 8. Proposed implementation plan

### 7I-1 — CI inventory cleanup

- Document the workflows and the exact check names they emit.
- Confirm stable check names for required status checks.
- Avoid required checks being skipped because of path filters or workflow duplication.

### 7I-2 — Contract validation hardening

- Validate OpenAPI and schema files with the same commands locally and in CI.
- Ensure the contract validation command is available to developers without searching through workflow YAML.
- Keep CI and local reproduce steps aligned.

### 7I-3 — Client/schema drift check

- Confirm whether the FE client is generated or handwritten.
- If generated, enforce a "generated client is up to date" check.
- If handwritten, document the compatibility boundary and add the strongest available schema/API compatibility check.

### 7I-4 — CI reliability cleanup

- Pin fragile action versions if needed.
- Avoid latest-release lookup failures.
- Add concurrency only if the workflow actually needs it.
- Keep logs readable and fail points obvious.

### 7I-5 — Full CI verification

- Push the PR.
- Wait for checks to complete.
- Fetch failed logs if any check fails.
- Do not merge until all required checks pass.

## 9. Risk matrix

| Risk | Impact | Likelihood | Mitigation |
| --- | --- | --- | --- |
| Required check skipped or pending | High | Medium | Keep required checks on workflows that always run for the relevant PR types; avoid path filters for required checks unless there is a fallback job |
| Workflow permission issue when editing `.github/workflows` | High | Medium | Ensure the token has `workflow` scope before implementation; treat this as a release blocker for workflow edits |
| Generated client drift | High | Medium | Regenerate and diff client artifacts in the same validation path |
| CI false positive | Medium | Medium | Keep contract validation narrow and deterministic; avoid masking failures with broad `continue-on-error` patterns |
| Action version or network lookup failure | Medium | Medium | Pin versions and avoid brittle latest lookup behavior |
| Contract validation too strict and blocks docs-only PRs | Medium | Low-Medium | Scope contract hardening to the right triggers and keep non-contract PRs from depending on contract-only jobs |

## 10. Acceptance criteria

- Spec identifies all workflows and checks.
- Spec identifies contract and schema artifacts.
- Spec defines local reproduce commands.
- Spec defines implementation slices.
- Spec says no runtime behavior changes.
- Spec says no required check removal.
- Spec includes full CI verification process.
- No code or workflow changes in this spec branch.

## 11. Manual steps for user

- Ensure `gh auth status` works before implementation.
- Ensure the token has `repo` and `workflow` scopes before workflow changes.
- Review the plan before allowing workflow edits.
- Do not merge if checks fail or remain pending.
- If CI fails, ask the agent to fetch real logs with `gh run view --log-failed`.

## 12. Open questions

- What is the exact OpenAPI source of truth for future contract changes?
- Is the FE client fully generated, partially generated, or handwritten in practice?
- Which checks are actually required by branch protection on the repository right now?
- Should `security-recheck` be required on docs-only PRs or only on security-sensitive changes?

## 13. PR #65 precondition verification

- Command executed: `gh pr view 65 --json number,state,mergeStateStatus,headRefName,baseRefName,statusCheckRollup,url`
- Command executed: `gh pr checks 65`
- Result: PR #65 is `MERGED`.
- Result: `statusCheckRollup` shows successful `build-test`, `contract-check`, `commit-check`, and `security-recheck`.
- Conclusion: the Phase 7I implementation gate is clear from the PR #65 precondition standpoint; do not start implementation on a newer precondition branch until this same verification is rechecked.

## 14. Branch protection / required checks verification

- Attempted read-only branch protection check with `gh api repos/lamthanhphuc/audiomind-monorepo/branches/main/protection`.
- Result: GitHub returned HTTP 403 (`Resource not accessible by personal access token`).
- Conclusion: required checks cannot be asserted from the API with the current token.
- Fallback manual step: verify required checks in the GitHub UI or retry with a token that has the needed repository/administrative read access.
- Do not guess required checks from workflow names alone.

## 15. Evidence / commands executed

- CodeGraph: `codegraph status`
- CodeGraph: `codegraph context "Phase 7I Contract CI Hardening spec audit PR65 precondition branch protection required checks"`
- CodeGraph: `codegraph query "Contract CI hardening PR65 branch protection required checks workflow path filter generated client drift"`
- CodeGraph: `codegraph affected`
- Targeted file inventory: `git ls-files ".github/workflows/*"`
- Targeted file inventory: `git ls-files "*openapi*" "*swagger*" "*contract*" "*schema*"`
- Targeted file inventory: `git ls-files "package.json" "FE-Audiomind/package.json" "demoRecordAUDIOMID/pom.xml"`
- Targeted file inventory: `git ls-files "packages/api-clients/*"`
- Targeted file inventory: `git ls-files "packages/contracts/*"`
- Read-only GitHub: `gh pr view 65 --json number,state,mergeStateStatus,headRefName,baseRefName,statusCheckRollup,url`
- Read-only GitHub: `gh pr checks 65`
- Read-only GitHub: `gh auth status`
- Read-only GitHub: `gh api repos/lamthanhphuc/audiomind-monorepo/branches/main/protection`
- Validation: `git diff -- docs/specs/contract-ci-hardening.md docs/reports/contract-ci-audit-results.md`
- Validation: `git diff --stat`
- Validation: `git diff --name-only`
- Validation: `git status --short --untracked-files=all`
