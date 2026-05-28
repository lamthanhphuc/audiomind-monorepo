# Phase 7G — Realtime vi+en STT Optimization

## 1. Status

- SPEC-ONLY
- Branch: `chore/realtime-stt-optimization-spec`
- Date: 2026-05-28
- No code implementation in this branch

## 2. Background from 7F

- Upload vi/en/multi passed.
- Realtime vi passed.
- Realtime en passed.
- Realtime multi technically worked, analysis worked, but quality was unstable and wrong-language output was observed in mixed vi+en speech.
- Do not default realtime to multi.
- 7F diagnostics are already in place and should be reused for 7G comparisons.

## 3. Goals

- Improve realtime vi/en mixed transcript quality.
- Keep the demo stable for normal vi and en usage.
- Decide whether any realtime multi optimization is safe enough for limited use.
- Preserve existing vi/en behavior.
- Keep analysis flow stable after stop.
- Produce a clear manual test matrix and explicit decision rules.

## 4. Non-goals

- Do not default realtime to multi.
- Do not implement automatic language switching.
- Do not use detect_language for realtime.
- Do not implement VAD auto pause/resume.
- Do not store original audio files.
- Do not change upload/batch STT unless needed only for comparison.
- Do not rewrite FE UX.

## 5. Current state

| Flow | Current config | 7F result | Risk |
| ---- | -------------- | --------- | ---- |
| Realtime vi | `language=vi`, `interim_results=true`, `smart_format=true`, `utterances=true`, optional `diarize=true`, language-specific endpointing when configured. | Pass. Transcript saved and analysis visible. | Low. |
| Realtime en | `language=en`, `interim_results=true`, `smart_format=true`, `utterances=true`, optional `diarize=true`, language-specific endpointing when configured. | Pass. Transcript saved and analysis visible. | Low. |
| Realtime multi | `language=multi`, `interim_results=true`, `smart_format=true`, `utterances=true`, optional `diarize=true`, multi-specific endpointing when configured. | Technically works, transcript and analysis run, but quality is unstable and wrong-language output was observed. | High. |
| Upload vi/en/multi | Batch flow already accepts explicit vi/en/multi and is out of scope unless needed as a comparison baseline. | Pass for vi/en/multi. | Low for current scope. |

Current implementation note:
- `ai-service` resolves the realtime model from `DEEPGRAM_REALTIME_MODEL`, then `DEEPGRAM_MODEL`, then `nova-2`.
- Realtime endpointing is resolved per language from `DEEPGRAM_REALTIME_ENDPOINTING_VI`, `DEEPGRAM_REALTIME_ENDPOINTING_EN`, `DEEPGRAM_REALTIME_ENDPOINTING_MULTI`, then a default/legacy fallback.
- Realtime diagnostics already log `requestedLanguage`, `effectiveLanguage`, `deepgramLanguage`, `model`, `endpointing`, `interimResults`, `smartFormat`, `utterances`, `diarize`, `detectLanguage`, `encoding`, `sampleRate`, `channels`, and final counters.

## 6. Optimization options

### Option A — Keep vi/en recommended, multi experimental

- Safe default.
- No behavior change.
- Recommended for demo use.

### Option B — Endpointing experiment for realtime multi

Test:

- `endpointing=300`
- `endpointing=500`
- `endpointing=800`
- `endpointing=1000`

Goal:

- Check whether longer endpointing reduces wrong-language output and premature cutoffs.

Safety rules:

- Run the endpointing experiment on realtime multi only first.
- Do not change vi/en endpointing globally for the experiment.
- Do not hardcode endpointing values directly if the existing env/config path already supports language-specific endpointing.
- Prefer `DEEPGRAM_REALTIME_ENDPOINTING_MULTI` or the equivalent language-specific config path if implementation happens later.

### Option C — Final/interim handling review

Check:

- Only final segments should persist after stop.
- Interim text should not be used for analysis.
- `is_final` and `speech_final` handling should not duplicate or corrupt segments.

### Option D — Separate upload vs realtime policy

- Upload multi can remain supported.
- Realtime multi remains experimental unless the matrix proves acceptable.

### Option E — UI/guide recommendation only

- Keep code unchanged.
- Guide users to choose vi or en for demo.
- Mark multi as experimental in docs.

## 7. Proposed 7G implementation slices

- 7G-1: spec + test matrix.
- 7G-2: endpointing config experiment, if safe.
- 7G-3: final/interim handling review.
- 7G-4: docs/report recommendation.
- 7G-5: optional minor UI copy or warning if approved later.

Proposed result output path:

- `docs/reports/realtime-stt-optimization-results.md`

Planned report fields:

- test date
- runtime model
- language
- endpointing
- script label
- score 0-5
- latency note
- wrong-language observation
- final recommendation

## 8. Manual test matrix

| Case | Language | Endpointing | Audio/script | Expected | Score |
| ---- | -------- | ----------- | ------------ | -------- | ----- |
| RT-VI-1 | vi | current | vi-only | correct vi transcript | 0-5 |
| RT-EN-1 | en | current | en-only | correct en transcript | 0-5 |
| RT-MIX-300 | multi | 300 | vi+en mixed | no wrong-language output | 0-5 |
| RT-MIX-500 | multi | 500 | vi+en mixed | compare quality | 0-5 |
| RT-MIX-800 | multi | 800 | vi+en mixed | compare quality | 0-5 |
| RT-MIX-1000 | multi | 1000 | vi+en mixed | compare quality and latency | 0-5 |

Scoring rubric:

- 0 = fail or wrong language severe
- 1 = mostly wrong
- 2 = partially understandable
- 3 = demo usable
- 4 = good
- 5 = very good

## 9. Manual steps for user

1. Prepare three scripts: vi-only, en-only, and mixed vi+en.
2. Read each script for 10-20 seconds.
3. Use the same mic and environment across all runs.
4. Test vi/en baseline first.
5. Test multi with the endpointing variants above.
6. Record a score and short notes for each run.
7. Do not paste full transcript text if it may contain personal information.

Sample scripts:

- vi-only: "Xin chào, hôm nay chúng ta kiểm tra tính năng ghi âm thời gian thực và phân tích nội dung sau khi dừng."
- en-only: "Today we are testing the realtime transcription feature and checking the analysis result after stopping the recording."
- mixed vi+en: "Hôm nay team sẽ review the realtime transcription feature, sau đó check analysis result and user experience."

## 10. Diagnostic logs to verify

- `REALTIME_STT_DIAGNOSTIC_CONFIG`
- `REALTIME_STT_SEGMENT_FINAL`
- `REALTIME_STT_DIAGNOSTIC_COMPLETED`
- `requestedLanguage`
- `effectiveLanguage`
- `deepgramLanguage`
- `model`
- `endpointing`
- `finalSegmentCount`
- `speechFinalCount`
- `isFinalCount`
- `transcriptLength`
- `transcriptHashPrefix`

Current code already emits the relevant realtime diagnostics in `ai-service`, and the stop-to-analysis path in `processing-service` reads the persisted transcript rows before sending a realtime-analysis request.

## 11. Decision rules

- If realtime multi remains below score 3, do not implement default multi.
- Realtime multi should reach score >= 3 before any limited-use recommendation.
- No severe wrong-language output should appear in at least 2 of 3 repeated mixed vi+en runs.
- Vi/en baseline must not regress.
- If endpointing 500 or 800 improves mixed vi+en without hurting latency too much, consider a config flag for multi only.
- If vi/en remain best for demo, keep vi/en recommended.
- Do not use detect_language for realtime.
- Do not auto-switch language in 7G.
- If multi is unstable, document it and defer advanced optimization.
- If multi remains unstable, 7G should end with docs/report recommendation only, not a routing change.

## 12. Risks

- Multi may hallucinate or output the wrong language.
- Longer endpointing may increase latency.
- Final/interim merge may duplicate segments.
- Changing endpointing globally may hurt vi/en.
- UI may imply multi is production-ready when it is not.

## 13. Acceptance criteria

- Spec states 7F findings clearly.
- Spec says not to default realtime to multi.
- Spec defines endpointing experiment plan.
- Spec defines manual matrix and score rubric.
- Spec defines 7G decision rules.
- No code changes.

## 14. Proposed result reporting

Proposed result output path:

- `docs/reports/realtime-stt-optimization-results.md`

The future report should capture:

- test date
- runtime model
- language
- endpointing
- script label
- score 0-5
- latency note
- wrong-language observation
- final recommendation
