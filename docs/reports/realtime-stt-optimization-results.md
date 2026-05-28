# Phase 7G — Realtime vi+en STT Optimization Results

- Test date: `YYYY-MM-DD`
- Runtime model: `DEEPGRAM_REALTIME_MODEL=<value>`
- Branch: `chore/realtime-stt-optimization-spec`

## Environment / Config

- `DEEPGRAM_REALTIME_ENDPOINTING_VI=`
- `DEEPGRAM_REALTIME_ENDPOINTING_EN=`
- `DEEPGRAM_REALTIME_ENDPOINTING_MULTI=`
- `DEEPGRAM_REALTIME_ENDPOINTING_DEFAULT=`
- `DEEPGRAM_ENDPOINTING=`
- Other notable runtime flags:
  - `DEEPGRAM_SIMPLIFY_STREAMING_URL=`
  - `ENABLE_SPEAKER_DIARIZATION=`
  - `DEEPGRAM_DIARIZE=`

## Results Matrix
tất cả test multi đều nói Hôm nay team sẽ review the realtime transcription feature, sau đó check analysis result and user experience.
| Case | Language | Endpointing | Script label | Score 0-5 | Latency note | Wrong-language observation | Notes |
| ---- | -------- | ----------- | ------------ | --------- | ------------ | -------------------------- | ----- |
| RT-VI-1 | vi | current | vi-only |4 | | | |
| RT-EN-1 | en | current | en-only |4 | | | |
| RT-MIX-300 | multi | 300 | vi+en mixed |0 | | | dịch sai sang ngôn ngữ, trancsript nhận được SPEAKER_1
Ben, don't you have
0:00 - 0:04
SPEAKER_1
Shout down, check, analyze, show user experience.
0:06 - 0:10 |
| RT-MIX-500 | multi | 500 | vi+en mixed |0 | | |dịch sai sang ngôn ngữ, kết ủa nhận được SPEAKER_1
हमने team se review
0:00 - 0:04
SPEAKER_1
da ryutan genucion fijja check another result and user
0:04 - 0:10  |
| RT-MIX-800 | multi | 800 | vi+en mixed |1 | | |dịch sai sang ngôn ngữ, kết quả nhận được SPEAKER_1
Her 19 fairy view the real time changesen feature. Showdown check and edit results and user it61%
0:00 - 0:08
SPEAKER_1
period.
0:08 - 0:10  |
| RT-MIX-1000 | multi | 1000 | vi+en mixed |1 | | |dịch sai sang ngôn ngữ, kết quả nhận được SPEAKER_1
Ham main din fer reveal da reveal time generation feature. Thou dong36%
0:00 - 0:08
SPEAKER_1
check another issue and user it, period.
0:08 - 0:12 |

## Decision

- vi/en baseline regression? `yes/no`
- multi score >= 3? `yes/no`
- severe wrong-language output in 2/3 runs? `yes/no`
- recommendation: `<keep vi/en recommended | keep multi experimental | multi limited-use candidate>`

## Safety Notes

- Do not paste full transcripts.
- Do not include PII or secrets.
- Keep references to meeting ID, trace ID, and short hash prefixes only.
