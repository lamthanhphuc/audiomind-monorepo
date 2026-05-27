# Phase 7F - Multi en+vi STT Investigation

## 1. Status
- SPEC-ONLY
- Branch: chore/multilingual-stt-investigation-spec
- Date: 2026-05-27
- No implementation code in this branch

## 2. Link to previous phases
- 7B health/readiness is already in place.
- 7C error response standardization is already in place.
- 7D logging and debuggability is already in place.
- 7E analysis reliability has already been hardened.
- 7F only investigates STT behavior for vi, en, and multi.
- 7G is the first phase that may implement routing changes, if 7F produces a clear result.

## 3. Current STT state

| Flow | Current language handling | Deepgram params known today | Gaps |
| ---- | ------------------------- | --------------------------- | ---- |
| upload/batch vi | processing-service accepts `vi` and forwards it to ai-service; ai-service batch normalization keeps `vi` and falls back to `vi` for invalid values. | `language=vi`, `model=nova-2` by default, `smart_format=true`, `utterances=true`, optional `diarize=true` when speaker diarization is enabled. No `detect_language` is used today. | No objective transcript-quality score yet for pure Vietnamese batch audio, and no evidence that any batch path should change default routing. |
| upload/batch en | processing-service accepts `en` and forwards it to ai-service; ai-service batch normalization keeps `en`. | `language=en`, `model=nova-2` by default, `smart_format=true`, `utterances=true`, optional `diarize=true` when speaker diarization is enabled. No `detect_language` is used today. | No objective transcript-quality score yet for pure English batch audio, and no evidence that the current model choice should change. |
| upload/batch multi | processing-service accepts `multi` and forwards it to ai-service; ai-service batch normalization keeps `multi`. | `language=multi`, `model=nova-2` by default, `smart_format=true`, `utterances=true`, optional `diarize=true` when speaker diarization is enabled. No `detect_language` is used today. | No matrix evidence yet for mixed vi+en batch audio, and no proof that `multi` is better or worse than explicit vi/en on upload. |
| realtime vi | processing-service snapshots the realtime language from the websocket session and forwards it to ai-service; ai-service resolves `vi` and sets language-specific endpointing. | Runtime-configured model; observed current runtime logs show `realtime_model=nova-3` and `batch_model=nova-2`. Realtime params today include `language=vi`, `interim_results=true`, `smart_format=true`, `utterances=true`, optional `diarize=true`, and language-specific `endpointing` if configured. Final transcript events are built from `is_final` and `speech_final`. | 7F must log the actual effective model per run instead of assuming it. No objective quality score yet for pure Vietnamese realtime audio, and no evidence yet that endpointing is optimal for code-switch cases. |
| realtime en | processing-service snapshots `en` and forwards it to ai-service; ai-service resolves `en` and uses the English endpointing path. | Runtime-configured model; observed current runtime logs show `realtime_model=nova-3` and `batch_model=nova-2`. Realtime params today include `language=en`, `interim_results=true`, `smart_format=true`, `utterances=true`, optional `diarize=true`, and language-specific `endpointing` if configured. Final transcript events are built from `is_final` and `speech_final`. | 7F must log the actual effective model per run instead of assuming it. No objective quality score yet for pure English realtime audio, and no evidence yet that current endpointing is the best setting for mixed-language speech. |
| realtime multi | processing-service accepts `multi` and forwards it to ai-service; ai-service resolves `multi` and uses the multi endpointing path. | Runtime-configured model; observed current runtime logs show `realtime_model=nova-3` and `batch_model=nova-2`. Realtime params today include `language=multi`, `interim_results=true`, `smart_format=true`, `utterances=true`, optional `diarize=true`, and multi-specific `endpointing` if configured. Final transcript events are built from `is_final` and `speech_final`. | 7F must log the actual effective model per run instead of assuming it. No matrix evidence yet for mixed vi+en realtime audio, and no proof yet that `multi` improves code-switching without hurting monolingual audio. |

## 4. Goals
- Know exactly what params upload vi, en, and multi send to Deepgram.
- Know exactly what params realtime vi, en, and multi send to Deepgram.
- Measure transcript quality for pure Vietnamese, pure English, and code-switch vi+en audio.
- Log enough to compare requestedLanguage, effectiveLanguage, model, and source.
- Avoid logging full transcript text, raw provider payloads, or any provider secret.
- Decide whether 7G implementation work is needed after the investigation.

## 5. Non-goals
- No default STT behavior changes.
- No automatic multi routing.
- No FE UI changes.
- No analysis reliability changes.
- No Gemini changes.
- No contract changes.
- No transcript quality tuning in this phase.
- No detect_language routing unless evidence clearly supports it.

## 6. Investigation questions
- Does upload vi recognize Vietnamese reliably enough today?
- Does upload en recognize English reliably enough today?
- Does upload multi preserve code-switch vi+en better than vi or en?
- Does realtime vi drop English segments?
- Does realtime en drop Vietnamese segments?
- Does realtime multi handle code-switch vi+en better than vi or en?
- Does multi hurt pure vi or pure en audio quality?
- Is detect_language currently enabled anywhere in upload or realtime paths?
- Should realtime prefer language=multi over detect_language if streaming detection is unsupported?
- Does current endpointing cut code-switch sentences too early?

## 7. Diagnostic logging plan

Current state note:
- Some batch logs already exist today, including `BATCH_STT_EFFECTIVE_CONFIG`, `STT_PROVIDER_SELECTED`, and `BATCH_STT_START`.
- 7F diagnostic logging should fill gaps around `requestedLanguage` / `effectiveLanguage` consistency, multi comparison, realtime segment counters, endpointing, and quality metadata.
- Realtime diagnostic logging is the higher-risk gap and should be prioritized before manual realtime matrix execution.

Proposed upload events, not yet implemented:
- BATCH_STT_DIAGNOSTIC_START
- BATCH_STT_DIAGNOSTIC_CONFIG
- BATCH_STT_DIAGNOSTIC_COMPLETED
- BATCH_STT_DIAGNOSTIC_FAILED

Proposed realtime events, not yet implemented:
- REALTIME_STT_DIAGNOSTIC_START
- REALTIME_STT_DIAGNOSTIC_CONFIG
- REALTIME_STT_SEGMENT_FINAL
- REALTIME_STT_DIAGNOSTIC_COMPLETED
- REALTIME_STT_DIAGNOSTIC_FAILED

Fields to keep:
- traceId
- requestId
- jobId
- meetingId
- source
- requestedLanguage
- effectiveLanguage
- deepgramLanguage
- model
- detectLanguage
- endpointing
- interimResults
- speechFinalCount
- isFinalCount
- finalSegmentCount
- audioDurationSec if available
- transcriptLength
- transcriptHashPrefix
- durationMs
- errorCode

Fields to avoid logging:
- Deepgram API key
- Authorization header
- full transcript text
- raw audio path if it could identify a user
- raw provider response
- raw WebSocket payloads with long content

## 8. Test matrix

| Case | Flow | Selected language | Audio type | Expected observation | Score |
| ---- | ---- | ----------------- | ---------- | -------------------- | ----- |
| upload vi + audio pure Vietnamese | upload/batch | vi | pure vi | Vietnamese should be preserved with minimal loss and no unexpected English degradation. | TBD |
| upload en + audio pure English | upload/batch | en | pure en | English should be preserved with minimal loss and no unexpected Vietnamese degradation. | TBD |
| upload multi + audio mixed vi+en | upload/batch | multi | mixed vi+en | Code-switch should survive better than vi or en if multi is the right path. | TBD |
| upload vi + audio mixed vi+en | upload/batch | vi | mixed vi+en | Vietnamese should remain readable, but English may degrade or disappear. | TBD |
| upload en + audio mixed vi+en | upload/batch | en | mixed vi+en | English should remain readable, but Vietnamese may degrade or disappear. | TBD |
| realtime vi + audio pure Vietnamese | realtime | vi | pure vi | Final transcript should remain complete and not be cut too early. | TBD |
| realtime en + audio pure English | realtime | en | pure en | Final transcript should remain complete and not be cut too early. | TBD |
| realtime multi + audio mixed vi+en | realtime | multi | mixed vi+en | Code-switch should survive better than vi or en if multi is the right path. | TBD |
| realtime vi + audio mixed vi+en | realtime | vi | mixed vi+en | Vietnamese may be strong, but English segments may be dropped or mistranscribed. | TBD |
| realtime en + audio mixed vi+en | realtime | en | mixed vi+en | English may be strong, but Vietnamese segments may be dropped or mistranscribed. | TBD |

Scoring rubric:
- 0 = fail or empty
- 1 = mostly wrong, major meaning loss
- 2 = understandable but many errors
- 3 = usable for demo
- 4 = good
- 5 = very good

Criteria to score:
- Does it lose Vietnamese segments?
- Does it lose English segments?
- Does code-switch get ignored?
- Are punctuation and formatting acceptable?
- Are names and technical terms badly distorted?
- Does realtime final transcript get cut off too early?
- Is latency still acceptable for demo use?

## 9. Manual validation plan

Upload:
- Start the full stack, including celery-worker.
- Upload a Vietnamese, English, or mixed-language audio file.
- Choose language vi, en, or multi.
- Poll status until COMPLETED or FAILED.
- Record params, logs, and quality score.

Realtime:
- Start realtime streaming.
- Stream a Vietnamese, English, or mixed-language sample.
- Stop the session.
- Record final transcript behavior.
- Check final segment count, speech_final, and is_final if the logs expose them.
- Use sample audio that is 10-30 seconds long.
- Prefer vi-only, en-only, and mixed vi+en samples.
- Do not use audio that contains PII.
- Do not commit audio files into the repository.

Commands:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.dev.yml up -d db redis ai-api celery-worker processing-api meeting-api user-api web

docker compose --env-file infra/.env -f infra/docker-compose.dev.yml logs processing-api ai-api celery-worker | Select-String -Pattern "BATCH_STT|REALTIME_STT|DEEPGRAM|requestedLanguage|effectiveLanguage|language=multi|language=vi|language=en" -CaseSensitive:$false

docker compose --env-file infra/.env -f infra/docker-compose.dev.yml exec -T redis redis-cli llen audio_processing
```

## 10. Data recording template

| Date | Flow | Audio | Selected language | Effective language | Model | Params summary | Score | Notes |
| ---- | ---- | ----- | ----------------- | ------------------ | ----- | -------------- | ----- | ----- |

Use notes for:
- which segment was lost, if any
- whether Vietnamese or English was recognized
- perceived latency
- whether the transcript is good enough for demo use

Do not paste full transcripts. If a short excerpt is needed, keep it brief and remove any PII.

Proposed result output path:
- docs/reports/multilingual-stt-investigation-results.md

## 11. Decision rules for 7G
- If multi is clearly better for code-switch and does not noticeably hurt pure vi or pure en audio, 7G should implement explicit multi routing.
- If multi is good for realtime but not for upload, 7G should only apply the realtime path.
- If multi is not stable enough, keep vi/en and add guidance to choose language explicitly.
- Do not use detect_language for realtime unless docs and current behavior prove it is supported.
- Do not change the default language to multi without evidence.

## 12. Risks and open decisions
- Does multi increase latency or cost?
- Does multi make pure Vietnamese worse?
- Does endpointing cut code-switch sentences too early?
- Does the FE language selector already pass multi correctly?
- Do we need more standardized sample audio files?
- Do we need stronger redaction in diagnostic logs?
- Do we need a separate `STT_DIAGNOSTIC_LOGGING` flag?

## 13. Implementation slices after this spec
- 7F-1: diagnostic logging for upload and batch STT
- 7F-2: diagnostic logging for realtime STT
- 7F-3: manual execution of the test matrix
- 7F-4: investigation report with scores
- 7F-5: 7G decision and follow-up scope

## 14. Acceptance criteria for 7F
- Spec includes current upload and realtime state.
- Spec includes a Deepgram docs verification checklist.
- Spec includes a diagnostic logging plan.
- Spec includes a vi/en/multi test matrix.
- Spec includes a scoring method.
- Spec includes manual validation commands.
- Spec includes decision rules for 7G.
- No code changes are introduced in this branch.

## 15. Official docs to verify before 7G
- Deepgram language parameter documentation.
- Deepgram multilingual and code-switching documentation for `language=multi`.
- Deepgram language detection documentation, with special attention to whether streaming supports it.
- Deepgram Vietnamese STT support documentation.
- Deepgram endpointing, interim result, and final result behavior documentation.
- Deepgram Nova-2 and Nova-3 language support documentation.

Manual verification note:
- Confirm the exact doc titles and current provider guidance before any 7G implementation decision.
