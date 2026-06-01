# Auth/Ownership + Transcript Export Audit Results (7P Close)

## Scope

- Branch: `feature/auth-ownership-transcript-export-spec`
- Target phase: `7P — Auth Entry + Ownership Hardening + Raw/Readable Transcript Export MVP`
- Updated: 2026-06-01
- Result: phase-close wording polish and scope lock

## CodeGraph usage

Commands executed for this close pass:

- `codegraph status`
- `codegraph context "7P final polish close phase known limitation readable transcript best effort canonical transcript 7Q"`
- `codegraph query "auth ownership transcript export readable raw mode DOCX preview known limitation"`
- `codegraph query "ProcessingService readable transcript helper report export TXT CSV raw mode tests"`
- `codegraph affected`

`codegraph affected` returned: `No files provided. Use file arguments or --stdin.`
Targeted reads were used instead of broad repo scanning.

## Final 7P scope lock

7P is considered complete as a security/export MVP when all of the following work safely:

- `/register` auth entry and login/register navigation
- ownership hardening for meeting access and export/report paths
- DOCX owner-gated export
- TXT/CSV transcript export with `mode=readable|raw` (`readable` default)

## Readable transcript policy in 7P

- Readable transcript is a **best-effort** presentation from saved STT fragments.
- Readable output may collapse obvious repeated fragments.
- 7P does not guarantee perfect canonical cleanup.

## Known limitation accepted in 7P

- Readable mode may still contain partial/awkward transcript fragments.
- This limitation is explicitly accepted for 7P and is not expanded further in this phase.

## Deferred to 7Q (canonical pipeline)

7Q owns:

- raw/canonical transcript split
- canonical transcript storage
- old-meeting backfill
- UI/report/export canonical consumption
- Gemini/report consumers aligned to canonical transcript

## Behavior guardrails that remain unchanged

- Export/report path does not call STT
- Export/report path does not call Gemini cleanup
- Export/report path does not call `/processing/start`
- Export/report path remains read-only with owner gate and cross-owner protection
- Raw mode preserves saved transcript rows
- Readable mode remains best-effort

## Close-out note

This document intentionally avoids claiming full transcript cleanup in 7P.
Canonical transcript quality work is deferred to 7Q by scope decision.