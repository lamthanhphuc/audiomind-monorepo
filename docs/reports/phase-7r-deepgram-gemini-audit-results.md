# Phase 7R Deepgram + Gemini Audit Results

## Scope

Audit-only review of the current architecture to prepare a Deepgram + Gemini migration plan without changing runtime code.

## Files and Areas Reviewed

- [demoRecordAUDIOMID/ai-service/app/main.py](../../demoRecordAUDIOMID/ai-service/app/main.py)
- [demoRecordAUDIOMID/ai-service/app/config.py](../../demoRecordAUDIOMID/ai-service/app/config.py)
- [demoRecordAUDIOMID/ai-service/app/pipeline.py](../../demoRecordAUDIOMID/ai-service/app/pipeline.py)
- [demoRecordAUDIOMID/ai-service/app/schemas.py](../../demoRecordAUDIOMID/ai-service/app/schemas.py)
- [demoRecordAUDIOMID/ai-service/app/services/analysis_factory.py](../../demoRecordAUDIOMID/ai-service/app/services/analysis_factory.py)
- [demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py](../../demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py)
- [demoRecordAUDIOMID/ai-service/app/services/gemini_analyzer.py](../../demoRecordAUDIOMID/ai-service/app/services/gemini_analyzer.py)
- [demoRecordAUDIOMID/ai-service/app/services/speech_recognizer.py](../../demoRecordAUDIOMID/ai-service/app/services/speech_recognizer.py)
- [demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py](../../demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py)
- [demoRecordAUDIOMID/ai-service/app/services/transcript_canonicalizer.py](../../demoRecordAUDIOMID/ai-service/app/services/transcript_canonicalizer.py)
- [demoRecordAUDIOMID/ai-processing-service/app/main.py](../../demoRecordAUDIOMID/ai-processing-service/app/main.py)
- [demoRecordAUDIOMID/whisper-service/app/main.py](../../demoRecordAUDIOMID/whisper-service/app/main.py)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/ProcessingController.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/ProcessingService.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportData.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/service/report/MeetingReportData.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/dto/TranscriptResponse.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/dto/TranscriptResponse.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/dto/AnalysisResponse.java](../../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/controller/dto/AnalysisResponse.java)
- [infra/docker-compose.dev.yml](../../infra/docker-compose.dev.yml)

## Current Whisper Usage Map

- `SpeechRecognizer` is the local Whisper batch implementation in `ai-service`.
- `ai-processing-service` still calls `whisper-service` over HTTP for transcription.
- `whisper-service` itself loads OpenAI Whisper locally and exposes `/transcribe`.
- `ai-service` still logs Whisper model/device information and retains local-whisper fallback code paths.

## Current Ollama Usage Map

- `AIAnalyzer` still supports Ollama analysis and chunk-summary flows.
- `ai-processing-service` still uses Ollama for final conversation summarization.
- `processing-service` still depends on `ollama-service` in default dev compose.
- `ai-service` readiness and config still retain Ollama-related settings and fallback references.

## Current Gemini Usage Map

- `GeminiAnalyzer` is present as a dedicated Gemini implementation.
- `analysis_factory.py` can select Gemini when `analysis_provider=gemini`.
- `AIAnalyzer` has Gemini-specific JSON request, parsing, retry, and fallback logic.
- `ai-service` readiness checks explicitly require Gemini config when Gemini is selected.

## Current STT Config Map

- `STT_PROVIDER` defaults to Deepgram in `ai-service` settings.
- Deepgram config exists for API key, model, language, timeout, endpointing, simplification, raw-message debug, and diarization.
- `ai-service` still carries `whisper_model`, `local_whisper_enabled`, and related local-model settings.
- `ai-processing-service` still has `WHISPER_SERVICE_URL`, `DIARIZATION_SERVICE_URL`, `OLLAMA_BASE_URL`, and `OLLAMA_MODEL` env wiring.

## Policy Implications for 7R

- Whisper and Ollama can remain as legacy code short term, but they should not be automatic fallback providers in the default runtime.
- Any fallback to legacy local providers should be gated by explicit opt-in env flags.
- Deepgram requests should always log the effective provider, model, language, recognition mode, endpointing, diarization, and utterances/paragraphs settings.
- Deepgram requests should not rely on an implicit default language.
- Gemini should stay on the post-transcript analysis boundary only; it should not replace Deepgram STT in 7R.

## Current Transcript Flow Map

1. Audio upload or realtime chunk enters `ai-service`.
2. STT is handled by Deepgram adapter in the main ai-service path, or by local Whisper in legacy batch paths.
3. Raw transcript rows are preserved as structured segment maps.
4. `transcript_canonicalizer.py` produces the deterministic 7Q canonical transcript version/hash.
5. `processing-service` chooses between state transcript and AI-service transcript payloads, then surfaces readable/canonical transcript data.
6. `processing-service` report generation consumes raw transcript rows for previews and exports.
7. `GeminiAnalyzer` or `AIAnalyzer` produces structured business analysis that feeds UI/report consumers.

## Current Docker Service Dependency Map

- `ai-api` depends on `ollama-service` in the current dev compose.
- `celery-worker` also depends on `ollama-service`.
- `processing-service` depends on `whisper-service`, `diarization-service`, and `ollama-service`.
- `whisper-service`, `diarization-service`, and `ollama-service` are all present in the default compose graph.
- `meeting-api`, `user-api`, `db`, and `redis` remain in the default stack.

## Implementation Phase Changes Needed

1. Verify existing DeepgramSTTAdapter completeness, then wire all upload and realtime STT paths to it. Add new adapter code only if the current adapter is incomplete.
2. Ensure Deepgram output consistently maps into the raw transcript contract consumed by canonicalization.
3. Keep the 7Q canonicalizer as the post-STT step.
4. Make Gemini the default analysis provider in config and runtime selection.
5. Add test coverage that mocks Deepgram and Gemini responses.
6. Plan the later Docker cleanup that removes legacy services from the default compose path.

## Implementation Guardrails

- Do not modify ownership, register, export, or report unless a compile or test failure forces a minimal compatibility change.
- Do not rewrite the canonicalizer.
- Do not delete legacy provider files in the first implementation PR unless tests show the deletion is safe.
- Docker image and cache cleanup remains a later 7T concern.

## Do Not Touch in Implementation Phase

- The 7Q canonical transcript algorithm and its version/hash semantics.
- Transcript/export/report surfaces that already consume canonical fields.
- Ownership and worker coordination behavior unrelated to provider migration.
- Docker caches/images and other artifact cleanup.
- Large UI redesign work.

## Recommended Implementation Order

1. Verify existing DeepgramSTTAdapter completeness, then wire all upload and realtime STT paths to it. Add new adapter code only if the current adapter is incomplete.
2. Map Deepgram output to `rawTranscriptRows`.
3. Keep 7Q canonicalizer after Deepgram.
4. Switch default `STT_PROVIDER=deepgram`.
5. Switch analysis default to Gemini.
6. Add mock tests.
7. Move Whisper/Ollama services out of the default compose path in a later cleanup phase.
8. Run manual sample-audio benchmarks for `vi`, `en`, and `multi`.
9. If needed, proceed to Phase 7S speaker stabilization.

## 7R Implementation Notes

- Default `ai-service` config now selects Deepgram STT and Gemini analysis.
- Local Whisper/Ollama legacy paths remain available only behind explicit `ALLOW_LEGACY_LOCAL_STT=true` and `ALLOW_LEGACY_LOCAL_AI=true` opt-in flags.
- Deepgram batch and realtime paths log the effective provider, model, language/recognition mode, endpointing, diarization, utterances, paragraphs, and request path without logging API keys.
- Dev compose keeps `whisper-service`, `diarization-service`, `ollama-service`, and the legacy `ai-processing-service` under the `legacy-offline` profile so the default stack does not require them.
