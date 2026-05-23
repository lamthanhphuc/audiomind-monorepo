# Realtime Quality Tuning

## Goal

Phase 5G improves realtime transcript quality and stability by making Deepgram realtime tuning config-driven. The work focuses on enabling per-realtime-language endpointing profiles (and a clear, upgrade-safe config contract) so engineers can iterate on Deepgram tuning (endpointing and related realtime params) without code changes or risk to upload/batch paths.

## Current Flow

FE-Audiomind -> processing-service WebSocket -> ai-service -> Deepgram realtime STT (WebSocket)

Key ai-service locations discovered:
- Deepgram WebSocket URL built in `app.services.stt_adapter.DeepgramSTTAdapter._build_websocket_url` (adds `model`, `language`, `interim_results`, `container`, optionally `smart_format`, `utterances`, `diarize`, and `endpointing` if configured).
- Realtime adapter created in `app.main._get_stt_adapter` (passes `endpointing=settings.deepgram_endpointing` into the adapter constructor).
- Effective runtime logging line `STT_STREAM_EFFECTIVE_CONFIG` is emitted in `app.main.stream_stt_chunk` and currently includes `language`, `speaker_mode`, `diarize`, and `model`.
- Global settings live in `app.config.Settings` (current single `deepgram_endpointing` present).

Automated tests touching this area:
- `demoRecordAUDIOMID/ai-service/tests/test_deepgram_stt_adapter.py` — validates websocket URL construction, diarization, and that `endpointing` is included when adapter configured.
- `demoRecordAUDIOMID/ai-service/tests/test_stt_stream_route.py` — exercises `stream_stt_chunk` behavior and mocks `_get_stt_adapter`.

## Deepgram Docs Notes

- `endpointing` controls how long Deepgram waits for silence before finalizing speech (measured in milliseconds).
- `endpointing` accepts millisecond values (for example `endpointing=300` or `endpointing=500`).
- Deepgram endpointing is enabled by default and the docs indicate a very short default (examples point to small default values such as 10ms).
- For multilingual code-switching on Nova-3 streaming, Deepgram recommends `endpointing=100` as a candidate to reduce language-detection artifacts when audio contains code-switching.
- `utterance_end_ms` requires `interim_results=true` to be effective.
- The docs note that `utterance_end_ms` values below ~1000ms often do not help because interim results are typically emitted on a ~1s cadence.
- `interim_results=true` provides preliminary streaming transcripts that are refined by final results; this improves UI responsiveness but influences tuning choices.


## Current Problems From Manual Testing

- `vi` mode generally works but still shows segment/speaker imperfections (split points, short gaps, and occasional misattributed words).
- `multi` (multilingual) mode routes correctly end-to-end but transcript quality sometimes degrades to gibberish or mis-detected languages in browser tests.
- `multiple` speaker mode enables diarization, but speaker split quality is not always reliable (false splits, missed speaker labels, inconsistent speaker numbering).
- These are quality / tuning issues — Phase 5F routing and mode selection are functioning as designed.

## Scope

In-scope:
- Realtime STT only (WebSocket streaming path).
- Deepgram realtime tuning via configuration (endpointing profiles first, then selective additional params).
- Per-realtime-language endpointing configuration and safe fallback behavior.
- Improve `STT_STREAM_EFFECTIVE_CONFIG` to surface endpointing and origin (language-specific/default/fallback).
- Targeted unit + integration tests for adapter URL behavior and `STT_STREAM_EFFECTIVE_CONFIG` logging.

Out-of-scope:
- SSE, upload/batch audio paths and tuning for prerecorded endpoints.
- Major WebSocket architecture refactor.
- Large new UI surfaces or features.
- Replacing Deepgram provider.
- Automatic transcript quality scoring or forcing perfect diarization.

## Tunable Parameters (candidates)

Priority candidate list (inspect and consider supporting):
- `model` (DEEPGRAM_REALTIME_MODEL / DEEPGRAM_MODEL)
- `language` (vi / en / multi)
- `endpointing` (milliseconds-based silence/finalization threshold) — PRIMARY target for Phase 5G
- `diarize` (already supported)
- `interim_results` (true/false)
- `smart_format` (true/false)
- `punctuate` / `utterances` (utterances already in URL)
- `vad_events` (if applicable to Deepgram realtime)
- `utterance_end_ms` or any provider-specific endpointing tuning

Note: Phase 5G does not need to expose every parameter. Endpointing is the first pragmatic tuning target.

## Proposed Config Contract

Add new realtime-only config variables (env-friendly names):

- `DEEPGRAM_REALTIME_ENDPOINTING_DEFAULT` — default endpointing value applied to realtime if no language-specific override.
- `DEEPGRAM_REALTIME_ENDPOINTING_VI` — realtime endpointing for Vietnamese sessions (`language=vi`).
- `DEEPGRAM_REALTIME_ENDPOINTING_EN` — realtime endpointing for English sessions (`language=en`).
- `DEEPGRAM_REALTIME_ENDPOINTING_MULTI` — realtime endpointing for multilingual sessions (`language=multi`).

Behavior rules:
- Language-specific env var (e.g., `DEEPGRAM_REALTIME_ENDPOINTING_VI`) wins over `DEEPGRAM_REALTIME_ENDPOINTING_DEFAULT` when present and valid.
- If neither language-specific nor default realtime env is present, preserve current behavior: use existing `DEEPGRAM_ENDPOINTING` if present (backwards-compat), otherwise omit `endpointing` from realtime URL.
  - Clarification: `DEEPGRAM_ENDPOINTING` is a legacy realtime fallback only when realtime previously relied on it. Do not expand legacy `DEEPGRAM_ENDPOINTING` usage into upload/batch paths; upload/batch behavior must remain unchanged.
- If a configured value is invalid (non-numeric, <= 0, or out-of-range for provider), fall back safely in this order: language-specific -> realtime default -> legacy `DEEPGRAM_ENDPOINTING` -> omit. Invalid values must not crash the service; they should be logged and ignored.
- Upload/batch paths must not use these realtime-only env vars. Batch/upload should continue to use the existing `deepgram_batch_model`, `deepgram_model`, and any legacy `DEEPGRAM_ENDPOINTING` only if previously used by batch (current code does not send endpointing for batch).
- Document which envs are realtime-only to avoid accidental reuse.

Env naming rationale: `DEEPGRAM_REALTIME_...` prefix makes purpose explicit and avoids accidental cross-path reuse.

## Endpointing Profiles To Test

Start experiments using `nova-3` (realtime model) with these candidates:
- `nova-3 + vi + endpointing=300` (baseline)
- `nova-3 + vi + endpointing=500` (smoother segmentation for long Vietnamese utterances)
- `nova-3 + vi + endpointing=100` (more aggressive splits — useful for code-switching)
- `nova-3 + multi + endpointing=300` (baseline multilingual)
- `nova-3 + multi + endpointing=100` (aggressive splits for mixed-language)
- `en` should keep current stable behavior unless explicitly configured (start by mirroring default).

Notes:
- `endpointing` is provider-specific; test values should be validated against Deepgram docs and a small set of real recordings.
- Consider adding a `DEEPGRAM_REALTIME_ENDPOINTING_SAFE_MAX` guard in code to prevent insane values, but this is optional for Phase 5G.

## Expected Logging Changes

Extend `STT_STREAM_EFFECTIVE_CONFIG` (in `stream_stt_chunk`) to include:
- `endpointing` (effective numeric value in milliseconds, or `omitted`)
- `endpointing_source` (one of `language_specific`, `realtime_default`, `legacy_global`, `omitted`, or `invalid_fallback`)
- Optional: `endpointing_env` (the env var name that provided the value, e.g. `DEEPGRAM_REALTIME_ENDPOINTING_VI`)

Example expanded log:

STT_STREAM_EFFECTIVE_CONFIG meeting_id=123 seq=1 language=vi model=nova-3 speaker_mode=single diarize=false endpointing=300 endpointing_source=language_specific endpointing_env=DEEPGRAM_REALTIME_ENDPOINTING_VI

Logging rules:
- Do not log API keys or authorization headers.
- Keep logs machine-parseable like existing format (single-line key=value style).

## Acceptance Criteria

- vi/en/multi routing remains unchanged.
- `speakerMode` single/multiple mapping to `diarize` remains unchanged.
- Endpointing can be configured per realtime language via the new `DEEPGRAM_REALTIME_*` env vars.
- Invalid endpointing values do not crash realtime code; they are ignored and logged.
- Deepgram realtime WebSocket URL includes `endpointing` only when a valid effective value is present.
- Upload/batch behavior remains unchanged (no accidental use of realtime-only envs).
- Unit tests for `DeepgramSTTAdapter._build_websocket_url` updated to assert language-specific websocket URLs and the adapter constructor behavior.
- `STT_STREAM_EFFECTIVE_CONFIG` log includes endpointing and its source.
- Existing Phase 5F tests continue to pass.

## Manual Browser Test Checklist

For each case below, run an interactive browser recording and capture ai-service logs.

Cases to run:
- `vi + single + endpointing=300` (baseline VI)
- `vi + single + endpointing=500` (smoother VI)
- `vi + multiple + endpointing=300` (diarize + vi)
- `vi + multiple + endpointing=500`
- `multi + single + endpointing=300`
- `multi + single + endpointing=100`
- `en + single` (regression check: no change unless configured)

For each case record:
- Deepgram WebSocket URL safe params (model/language/diarize/endpointing presence) — do not include API key
- `STT_STREAM_EFFECTIVE_CONFIG` log line
- Number of segments produced for a fixed sample (~10s) recording
- Duplicate/overlap behavior between segments
- Transcript quality notes (gibberish, mis-language, good)
- Delay/latency notes (perceived transcription delay or increased latency)
- Whether result is acceptable for demo (yes/no)

Keep a small set of representative audio samples: pure Vietnamese, pure English, and mixed Vietnamese/English.

## Implementation Plan For Later (high level)

1. Add new settings to `app.config.Settings` with sensible defaults:
   - `deepgram_realtime_endpointing_default: int | None`
   - `deepgram_realtime_endpointing_vi: int | None`
   - `deepgram_realtime_endpointing_en: int | None`
   - `deepgram_realtime_endpointing_multi: int | None`
   (Keep backwards-compatibility by preserving `deepgram_endpointing` and using it as a last-resort fallback.)
2. Implement resolver logic in `app.main` (or adapter factory) to pick effective endpointing per-stream based on normalized language.
   - Adapter/session safety: do not mutate a shared/global `DeepgramSTTAdapter` instance per request. Per-language endpointing must be resolved safely per realtime stream/session. If `_get_stt_adapter` currently returns a shared or cached adapter, do not store request-specific endpointing on that shared adapter. Prefer passing the effective endpointing as a per-session override, constructing a realtime adapter with the resolved value, or using another safe design that does not leak one session's endpointing into another session.
3. Pass the resolved `endpointing` into `DeepgramSTTAdapter` constructor only for realtime adapters (i.e., `_get_stt_adapter` path), or choose per-session override in `MeetingSessionActor.create` if per-actor control required.
4. Update `DeepgramSTTAdapter._build_websocket_url` to include endpointing when adapter/session has a valid value (already supported by current adapter).
5. Extend `STT_STREAM_EFFECTIVE_CONFIG` logging to include `endpointing` and `endpointing_source`.
6. Add unit tests in `tests/test_deepgram_stt_adapter.py` to assert language-specific websocket URLs and the adapter constructor behavior.
7. Add tests to ensure invalid env values are logged and ignored.
8. Run targeted browser tests, iterate on endpointing values, and choose final defaults to commit to repo docs.
9. Document chosen defaults and the manual test results in `docs/specs/realtime-quality-tuning.md` and `docs/manual-realtime-test-checklist.md`.

Note on defaults: initial endpointing values listed in this spec are experimental profiles for manual testing, not final production defaults. Phase 5G's goal is to make tuning config-driven so values can be changed after testing; final defaults must be selected only after manual browser testing and validation.

## Decision After Manual Testing

Document that after browser tests, the team should record:
- chosen endpointing for `vi` (milliseconds)
- chosen endpointing for `multi` (milliseconds)
- whether `en` remains omitted or has an explicit chosen value
- any known quality limitations that remain (diarization issues, persistent mis-detections, latency tradeoffs)

This record should be added to the spec or a linked doc and used to set final `DEEPGRAM_REALTIME_*` env values once agreed.

## Manual Test Result

- `vi + single + endpointing=500`: config and routing passed.
- `multi + single + endpointing=300`: config and routing passed, but transcript quality remains unreliable.
- `Nova-3` with `language=multi` remains experimental for demo use.
- Stable demo should prefer `vi` or `en`.
- Restricting multilingual recognition to only Vietnamese plus English likely needs a separate Flux/language_hint investigation.

## Risks / Known Limitations

- Endpointing may improve segmentation split behavior but will not necessarily fix multi-language recognition failures.
- Deepgram's multilingual model (`multi`) can sometimes mis-detect language segments; endpointing alone may not address all failure modes.
- Diarization quality depends on audio channel characteristics; perfect diarization is unlikely without more invasive changes.
- Chosen defaults must be validated empirically against representative recordings before being promoted to production.

---

## Analysis Summary

- Located Deepgram realtime URL construction in `demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py` (`_build_websocket_url`). It already supports an `endpointing` query param when `DeepgramSTTAdapter.endpointing` is set.
- `STT_STREAM_EFFECTIVE_CONFIG` logging is emitted in `demoRecordAUDIOMID/ai-service/app/main.py` (function `stream_stt_chunk`) and currently logs `language`, `speaker_mode`, `diarize`, and `model` but not `endpointing` or endpointing source.
- Global config currently exposes a single `deepgram_endpointing` (`app.config.Settings.deepgram_endpointing`) passed into `DeepgramSTTAdapter` in `_get_stt_adapter`.
- There is no per-language realtime endpointing currently; only a single global `DEEPGRAM_ENDPOINTING` is present in examples and infra environment files.
- Tests exist that assert adapter includes `endpointing` when provided and omits it when unset. These tests will need extension for per-language behavior.

## Current endpointing/config findings

- `DeepgramSTTAdapter` supports `endpointing` at instance-level and will add `endpointing` query param when `self.endpointing` is non-null.
- `app.main._get_stt_adapter` uses `settings.deepgram_endpointing` to set the adapter-level endpointing. This is a global value; no per-language resolution exists today.
- `app.config.Settings` defines `deepgram_endpointing` only; no `DEEPGRAM_REALTIME_*` envs exist yet.
- Unit tests: `tests/test_deepgram_stt_adapter.py` contains tests that validate URL includes endpointing when adapter constructed with `endpointing=300`.

## Is endpointing currently present / how used?

- Yes: A legacy `DEEPGRAM_ENDPOINTING` / `settings.deepgram_endpointing` exists and flows into `DeepgramSTTAdapter` at adapter creation time. That makes endpointing effectively global for realtime in the present codebase.
- Batch/upload paths do not inject `endpointing` into prerecorded Deepgram calls in current code (adapter's batch code does not add `endpointing` query param), so realtime endpointing currently only impacts streaming.

---
