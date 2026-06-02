# Phase 7R Deepgram + Gemini Migration Spec

## Goal

Phase 7R moves the project default runtime path from legacy offline services to cloud providers while preserving the Phase 7Q canonical transcript contract.

Target default flow:

Audio Upload / Realtime Audio
-> Deepgram STT
-> rawTranscriptRows
-> 7Q Canonical Transcript Pipeline
-> canonicalTranscriptRows
-> Gemini Business Analysis
-> UI / Export / Report

## Current Architecture Summary

The current codebase already contains a partial Deepgram integration in the `ai-service` and still retains Whisper/Ollama-based legacy paths.

### STT

- `ai-service` owns the real-time STT websocket/gRPC path and the batch transcript path.
- `DeepgramSTTAdapter` exists and is wired into `ai-service` through `_get_stt_adapter()`.
- `SpeechRecognizer` still implements Whisper-based local batch transcription.
- `ai-processing-service` still calls `whisper-service` and `diarization-service` directly, then summarizes through Ollama.

### Analysis

- `ai-service` has a provider factory that can select Ollama, Gemini, or OpenAI.
- `GeminiAnalyzer` exists and uses a structured Gemini JSON flow.
- `AIAnalyzer` still contains Ollama analysis and chunk-summary logic.

### Canonical transcript contract

- Phase 7Q canonical transcript fields are already present and must not be broken:
  - `rawTranscriptRows`
  - `canonicalTranscriptRows`
  - `canonicalTranscriptVersion`
  - `canonicalTranscriptHash`
- The canonicalizer is deterministic and versioned (`canonical-transcript-v2` in the current implementation).

## Migration Principles

1. Deepgram is the default STT provider.
2. Gemini is the default analysis provider.
3. Whisper and Ollama remain available short term as deprecated/legacy code.
4. Phase 7Q canonicalization remains the post-STT contract and is not rewritten.
5. Unit tests and CI must not call live Deepgram/Gemini APIs.
6. API keys must remain environment-driven; no hard-coded secrets.
7. Docker production behavior is not changed in this task beyond planning.

## Legacy Provider Fallback Policy

- Whisper and Ollama may remain as legacy code short term.
- They must not be automatic fallback providers in the default runtime.
- Any fallback to local legacy providers must require explicit opt-in env flags:
  - `ALLOW_LEGACY_LOCAL_STT=false`
  - `ALLOW_LEGACY_LOCAL_AI=false`
- Default runtime behavior should fail clearly when the cloud provider is unavailable instead of silently switching to legacy local providers.

## Proposed Environment and Config

Recommended defaults for 7R:

- `STT_PROVIDER=deepgram`
- `DEEPGRAM_API_KEY`
- `DEEPGRAM_MODEL=nova-3`
- `DEEPGRAM_LANGUAGE=vi|en|multi`
- `DEEPGRAM_SMART_FORMAT=true`
- `DEEPGRAM_DIARIZE=true`
- `DEEPGRAM_UTTERANCES=true`
- `DEEPGRAM_PARAGRAPHS=true`
- `ANALYSIS_PROVIDER=gemini`
- `GEMINI_API_KEY`
- `GEMINI_MODEL`

Compatibility note:

- Existing config names such as `deepgram_model`, `deepgram_realtime_model`, `deepgram_batch_model`, `analysis_provider`, `gemini_analysis_model`, and `gemini_summary_model` should be mapped carefully during implementation so that legacy callers keep working.
- Every Deepgram request must log the effective provider, model, language, recognitionMode, endpointing, diarization, and utterances/paragraphs settings.
- No Deepgram request should rely on an implicit default language.

## Recognition Mode Mapping

- `vi` -> Deepgram language `vi`
- `en` -> Deepgram language `en`
- `multi` -> benchmark Deepgram language `multi`
- prerecorded-only experiments may test `detect_language=true` if suitable for the adapter and model combination
- streaming multi must not rely on `detect_language` if provider docs say it is unsupported

## Deepgram STT Plan

### Upload transcription

- Route uploaded audio through Deepgram as the primary transcription provider.
- Map Deepgram utterances/segments into the existing raw transcript shape before canonicalization.
- Preserve timing, speaker labels, and text normalization behavior expected by downstream 7Q code.

### Realtime transcription

- If realtime audio is active, keep the websocket path but make Deepgram the default backend.
- Preserve endpointing, diarization, reconnect/cooldown, and partial-final event handling.
- Maintain compatibility with the current speaker normalization logic so speaker labels stay stable enough for downstream canonicalization.

### Diarization

- Prefer Deepgram-native diarization when available.
- Keep speaker mapping deterministic enough to feed canonical transcript rows.
- Do not remove the existing speaker normalization layer until a later stabilization phase proves the Deepgram labels are sufficiently stable.

## Gemini Analysis Plan

- Use Gemini as the default analysis provider for summaries, business analysis, keywords, risks, blockers, action items, and structured outputs.
- Preserve the existing structured JSON schema expectations used by the UI and report layers.
- Keep error handling explicit for missing config, invalid responses, parsing failures, and rate limiting.
- Do not invoke live Gemini in unit tests; mock the response schema instead.

## Gemini Boundary

- Gemini is used for post-transcript business analysis only in 7R.
- Do not use Gemini to replace Deepgram realtime STT in this phase.
- Keep Gemini structured JSON output and app-side semantic validation.

## Docker / Compose Plan

### Current state

- Default compose still launches `whisper-service`, `ollama-service`, and `diarization-service`.
- `ai-service` and `processing-service` environment blocks still reference those legacy services.

### 7R target

- Core/default compose should no longer require Whisper or Ollama for the main path.
- Legacy offline services may be moved into a separate profile or later cleanup phase.
- No Docker runtime changes are required in this audit-only task.

## Testing Plan

- Add or update tests that mock Deepgram responses and verify mapping to `rawTranscriptRows`.
- Add or update tests that mock Gemini responses and verify analysis schema parsing.
- Keep unit tests offline-only; no network calls in CI.
- Add manual sample-audio benchmarks for `vi`, `en`, and `multi` once runtime implementation exists.

## Definition of Done / Acceptance Criteria

- Upload STT path uses Deepgram by default.
- Realtime STT path uses Deepgram by default if a realtime path exists.
- Gemini is the default analysis provider.
- No default compose/runtime dependency on Whisper or Ollama for the core path.
- 7Q raw and canonical transcript contracts remain unchanged.
- Unit tests mock Deepgram and Gemini and make no network calls.
- No API keys are committed.

## Implementation Guardrails

- Do not modify ownership, register, export, or report unless a compile/test failure requires a minimal compatibility change.
- Do not rewrite the canonicalizer.
- Do not delete legacy provider files in the first implementation PR unless tests prove the change is safe.
- Docker image and cache cleanup remains a later 7T concern.

## Rollback Plan

- Keep Whisper/Ollama code paths in place for a short transition period.
- Support config switches so the system can fall back to legacy behavior if Deepgram/Gemini availability or cost becomes a blocker.
- Preserve canonical transcript compatibility so rollback does not invalidate 7Q exports or saved data.

## Risks

- API cost growth from cloud transcription and analysis.
- API key leakage if secrets are not handled strictly through env/config.
- Deepgram multi-language Vietnamese/English quality may vary by model and settings.
- Speaker diarization labels may be less stable than legacy diarization output.
- Cloud API downtime or network instability can block processing.

## Out of Scope

- No rewrite of ownership, register, export, or report behavior.
- No rewrite of the 7Q canonical pipeline.
- No removal of Docker images, caches, or build artifacts.
- No large UI optimization or redesign.
- No team/admin/share permission work.

## Recommended Implementation Order

1. Verify existing DeepgramSTTAdapter completeness, then wire all upload and realtime STT paths to it. Add new adapter code only if the current adapter is incomplete.
2. Map Deepgram output into `rawTranscriptRows`.
3. Keep the 7Q canonicalizer after Deepgram.
4. Switch default `STT_PROVIDER=deepgram`.
5. Switch analysis default to Gemini.
6. Add mock tests.
7. Move Whisper/Ollama services out of the default compose path in a later Docker cleanup phase.
8. Run manual `vi` / `en` / `multi` benchmarks.
9. Proceed to Phase 7S speaker stabilization if needed.
