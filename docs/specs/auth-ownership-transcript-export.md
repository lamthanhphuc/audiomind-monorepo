# 7P — Auth Entry + Ownership Hardening + Raw/Readable Transcript Export MVP

## 1. Status

- Final scope lock for 7P
- Branch: `feature/auth-ownership-transcript-export-spec`
- Updated: 2026-06-01
- 7P is complete as a security/export MVP

## 2. Final scope decision

7P is complete when the following are working safely and owner-scoped:

- Auth entry with `/register` plus login/register navigation
- Ownership hardening for meeting read/update/delete/export paths
- DOCX report export
- TXT/CSV transcript export with `mode=readable|raw` (default `readable`)

## 3. Readable transcript policy in 7P

- Readable transcript in 7P is **best-effort** presentation/export output from saved STT fragments.
- Readable mode may collapse obvious repeated fragments for usability.
- 7P does **not** claim perfect transcript cleanup.

## 4. Known limitation (accepted in 7P)

- Readable transcript mode may still contain some partial/awkward fragments.
- This is expected for 7P because there is no canonical transcript pipeline yet.

## 5. 7Q ownership (deferred)

7Q will own the canonical transcript pipeline work:

- Raw/canonical transcript split
- Canonical transcript storage
- Backfill for older meetings
- UI/report/export consumption from canonical transcript
- Gemini/report flows that should consume canonical transcript output

## 6. Non-goals for 7P

- No full canonical transcript generation pipeline
- No saved transcript DB rewrite/backfill
- No STT rerun from export/report path
- No Gemini-based transcript cleanup for export/report path
- No `/processing/start` or lazy-analysis trigger from export/report path
- No STT routing/default/multi behavioral changes

## 7. Export/report behavior contract in 7P

- `mode=readable` remains default
- `mode=raw` remains available and preserves saved transcript fragments
- Readable TXT/CSV and DOCX transcript preview use the shared readable presentation path
- Export/report path stays read-only and does not start processing
- Owner gate and cross-owner protections remain enforced

## 8. Validation checkpoints for this scope lock

- Auth/register flow remains available
- Ownership hardening remains active
- TXT/CSV raw/readable export behavior remains stable
- DOCX transcript preview remains bounded and best-effort
- No STT/Gemini/`/processing/start` invocation in export/report path