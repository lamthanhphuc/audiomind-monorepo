# Kế hoạch sửa chữa Audiomind – Tab+Mic, Finalize và Analysis

**Phiên bản:** 1.3
**Ngày:** 2026-06-30
**Trạng thái:** Draft - Pending Technical Preflight
**Mục tiêu:** Khắc phục lỗi realtime Tab+Mic, lỗi transcript đã persist nhưng analysis bị skip, đồng thời tăng độ ổn định cho Gemini retry/failover theo scope nhỏ và bám sát code hiện có.

---

## 1. Tổng quan vấn đề

Hệ thống hiện có năm vấn đề chính, chia thành ba nhóm:

| Nhóm                      | Vấn đề                                                       | Mức độ ưu tiên |
| ------------------------- | ------------------------------------------------------------ | -------------- |
| Realtime Tab+Mic identity | P1 – `streamId` rỗng hoặc không đi xuyên suốt pipeline       | Cao            |
| Realtime Tab+Mic identity | P2 – `segmentId` collide giữa tab và mic                     | Cao            |
| Finalize và analysis      | P3 – Transcript đã persist nhưng analysis bị skip            | Rất cao        |
| Finalize và analysis      | P5 – Tiny chunks khiến meeting bị `FAILED_AUDIO_CAPTURE` sai | Rất cao        |
| Gemini reliability       | P4a – Gemini retry/failover runtime behavior cần test/harden           | Trung bình |

### 1.1. Kết luận từ trace hiện tại

Trace meeting lỗi cho thấy:

* Transcript đã được persist.
* Meeting bị đánh dấu terminal `FAILED_AUDIO_CAPTURE`.
* Sau đó realtime analysis bị skip.
* FE polling analysis nhận `404`.
* Analysis chưa thực sự chạy tới Gemini.

Nguyên nhân cần xử lý trước không phải Gemini. Lỗi chính là finalize flow đánh dấu audio capture failed quá sớm, trước khi transcript cuối cùng được recover và trước khi existing analysis path được trigger.

### 1.2. Nguyên tắc sửa

1. Transcript có text non-blank là bằng chứng mạnh hơn heuristic tiny chunk.
2. `streamId` phải được truyền, giữ nguyên và xác thực xuyên suốt Tab+Mic pipeline.
3. Transcript identity ở tầng UI/merge phải unique theo `meetingId + streamId + segmentId`.
4. Không block WebSocket thread.
5. Tận dụng async path và idempotency hiện có trước khi thiết kế state machine mới.
6. Không tự đổi storage convention `stream_id` nếu chưa audit schema, query và migration.
7. `"default"` chỉ là fallback legacy/internal ở tầng identity; không phải audio stream ID từ FE recorder.
8. Không để FE polling mắc kẹt ở `404` khi service owner biết meeting tồn tại và analysis chưa hoàn tất.
9. Không tạo migration hoặc hardening architecture lớn khi fix local hiện có thể giải quyết lỗi.

---

# 2. Technical Preflight Result

Mục này là gate bắt buộc trước khi implement production code. Plan chỉ được chuyển sang trạng thái “implementable after preflight” khi các mục blocker đã pass.

## 2.1. Fact đã xác minh từ code

| Fact                                                                 | Vị trí đã xác minh             | Ý nghĩa                                                              |
| -------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| `triggerRealtimeAnalysisAsync(...)` chạy async                       | `MeetingWebSocketHandler.java` | Có thể tận dụng path async hiện có, không cần tạo state machine ngay |
| `runRealtimeAnalysis(...)` gọi `jobStateStore.tryStartAnalysis(...)` | Processing service             | Đã có lớp idempotency một phần                                       |
| `tryStartAnalysis(...)` có lock/state                                | `JobStateStore`                | Có xử lý running, completed, retryable failed hoặc cooldown          |
| `TranscriptFragment.stream_id` đã tồn tại                            | AI service model               | Không được mặc định tạo migration mới                                |
| Default `stream_id` hiện là `""`                                     | AI service model/checkpoint    | Không tự đổi default storage sang `"default"`                        |
| Checkpoint dùng `(meeting_id, stream_id)`                            | AI service                     | Stream identity đã tồn tại ở một phần persistence                    |
| FE chỉ gửi `stream_id` khi dual stream bật và có `streamId`          | `useRealtimeMeetingStream`     | Cần xác minh runtime payload Tab+Mic thật                            |
| `get_analysis(...)` có path trả `404` khi chưa có analysis row/job   | AI service                     | Cần xác minh service owner để tránh FE polling bị mắc kẹt            |
| FE gọi analysis qua `/processing/{meetingId}/analysis`               | `FE-Audiomind/src/services/api.ts` | Processing-service là gateway mà FE dùng cho realtime analysis polling |
| Processing-service kiểm tra meeting access, job state, AI fallback và lazy trigger trong `getAnalysisInternal(...)` | `ProcessingService.java` | Processing-service là source of truth đề xuất cho FE analysis status |
| `GEMINI_RETRY_QUOTA_EXCEEDED` đi từ settings vào `GeminiAnalyzer` và `AIAnalyzer` | `config.py`, `analysis_factory.py`, `gemini_analyzer.py`, `ai_analyzer.py` | Wiring env/config/factory đã có; cần test runtime behavior/failover |
| `rtk` chạy được                                                      | Repo tooling                   | Có thể dùng `rtk` cho read, grep, git status và test                 |
| Backend hiện normalize blank/unknown stream ID thành legacy `""` | `RealtimeStreamAudioState.normalizeStreamId(...)` | Đây là compatibility behavior hiện tại; Tab+Mic cần validation strict riêng, không áp dụng mù cho Tab-only |
| `resolveMergeKey(...)` hiện bỏ `streamSuffix` khi event có explicit `segmentId` | `FE-Audiomind/src/utils/transcript.ts` | Đây là defect P2 đã xác minh; explicit segment ID vẫn có thể collide giữa `tab` và `mic` |
| `finalizeSttSession(...)` đánh dấu `FAILED_AUDIO_CAPTURE` và return trước recovery ở nhánh `!audioReceived` và `isInvalidAudioCapture(...)` | `MeetingWebSocketHandler.finalizeSttSession(...)` | Đây là defect P3/P5 đã xác minh; recovery transcript chưa được gọi ở mọi failed-capture path |

## 2.2. Preflight blocker cần xác minh

Các mục dưới đây phải được kiểm tra thực tế bằng `rtk`, CodeGraph, runtime smoke test hoặc database inspection trước khi code.

| ID    | Nội dung cần xác minh         | Kết quả bắt buộc                                                                  |
| ----- | ----------------------------- | --------------------------------------------------------------------------------- |
| PF-01 | Runtime Tab+Mic payload thật  | Xác nhận `tab` và `mic` đi từ FE recorder đến persistence/transcript event        |
| PF-02 | Contract Tab-only             | Chốt rõ Tab-only gửi `stream_id=tab` hay omit `stream_id`                         |
| PF-03 | Tab+Mic invalid stream enforcement | Chốt behavior reject/drop/mark invalid cho blank hoặc unknown `stream_id` trong Tab+Mic; giữ compatibility Tab-only cho đến khi PF-02 hoàn tất |
| PF-04 | DB schema và constraints thật | Xác nhận có hoặc không constraint chặn `(meeting_id, segment_id)` khác stream     |
| PF-05 | Query/export/history          | Xác nhận nơi nào đang phụ thuộc convention storage `stream_id=""`                 |
| PF-06 | Recovery insertion point | Defect đã xác minh: cần chọn vị trí gọi recovery trước `FAILED_AUDIO_CAPTURE` ở cả nhánh `!audioReceived` và `isInvalidAudioCapture(...)`; xác nhận status sync khi recovery thành công |
| PF-07 | Recovery status authority     | Xác nhận recovery có thể ngăn terminal failure hoặc cập nhật status theo contract |
| PF-08 | Analysis API status contract  | Dùng processing-service làm source of truth; chốt mapping NOT_STARTED/PENDING/RUNNING/RETRYABLE_FAILED/SUCCEEDED/FAILED |
| PF-09 | Gemini retry/failover behavior | Xác nhận primary 429 -> backup, all keys exhausted -> retryable metadata, invalid/auth key không retry vô hạn |
| PF-10 | Test targets                  | Xác nhận tên test file/class thực tế trước khi chạy command trong plan            |

## 2.3. Output bắt buộc sau preflight

Trước khi bắt đầu implement, team phải ghi rõ kết quả cho các quyết định sau:

```text
1. Tab-only contract:
   - stream_id = "tab"
   hoặc
   - omit stream_id

2. Invalid stream_id behavior:
- Hiện tại backend normalize blank/unknown thành legacy "".
- Với Tab+Mic, chốt reject/drop hoặc mark invalid.
- Không silent fallback sang tab, mic hoặc default.
- Giữ compatibility Tab-only cho đến khi contract Tab-only được xác minh.

3. Transcript storage convention:
   - giữ ""
   hoặc
   - migration thật sự cần thiết và lý do cụ thể

4. Finalize recovery order:
- Defect đã xác minh: hai nhánh !audioReceived và isInvalidAudioCapture(...) currently mark FAILED_AUDIO_CAPTURE before calling recovery.
- Chốt helper hoặc call site để recovery/check transcript chạy trước terminal failure.
- Chỉ mark FAILED_AUDIO_CAPTURE khi recovery không tìm được transcript non-blank.

5. Analysis status owner:
   - processing-service đã được xác minh là endpoint FE gọi và là owner đề xuất.
   - Cần chốt exact response contract cho NOT_STARTED/PENDING/RUNNING/RETRYABLE_FAILED/SUCCEEDED/FAILED.

6. Gemini retry behavior:
   - backup key được thử khi nào
   - khi nào trả retryable failure
```

## 2.4. Preflight commands

```bash
rtk read docs/specs/fix.md

rtk grep "triggerRealtimeAnalysisAsync|runRealtimeAnalysis|tryStartAnalysis|recoverTranscriptAfterTerminalFinalize" .

rtk grep "stream_id|streamId|FAILED_AUDIO_CAPTURE|REALTIME_ANALYSIS_SKIPPED|get_analysis" .

rtk grep "GEMINI_RETRY_QUOTA_EXCEEDED|GEMINI_MULTI_KEY_ENABLED|retry_quota_exceeded" .

rtk git status --short
```

Candidate runtime commands cần xác minh theo Docker compose file thực tế:

```bash
rtk docker compose -f infra/docker-compose.dev.yml --env-file infra/.env logs --tail=500

rtk docker compose -f infra/docker-compose.dev.yml --env-file infra/.env logs --tail=500 processing-service ai-service
```

---

# 3. P1 – `streamId` rỗng hoặc dual-stream chưa active thật

## 3.1. Mục tiêu

Đảm bảo Tab+Mic luôn gửi metadata stream hợp lệ và stream identity đi xuyên suốt từ recorder đến transcript persistence.

## 3.2. Contract bắt buộc

```text
Tab+Mic payload:
- Chỉ cho phép stream_id = "tab" | "mic".

Tab-only payload:
- Dùng "tab" hoặc omit stream_id.
- Giá trị này phải được chốt sau PF-02.

Legacy transcript event:
- Nếu thiếu stream_id, FE identity helper có thể normalize thành "default".
- "default" không phải stream ID mà FE recorder gửi.

Invalid Tab+Mic stream_id:
- Blank, null hoặc unknown không được silent fallback sang tab, mic hay default.
- Chunk bị reject/drop hoặc mark invalid theo protocol hiện có.
- Một chunk invalid không được tự động làm terminal fail toàn bộ meeting.

Current confirmed behavior:
- `RealtimeStreamAudioState.normalizeStreamId(...)` hiện normalize blank/unknown stream ID thành legacy `""`.
- Đây là behavior compatibility hiện tại, không phải validation strict.

Required behavior change:
- Chỉ với session Tab+Mic: blank, null hoặc unknown stream_id phải bị reject/drop hoặc mark invalid.
- Không silent fallback sang tab, mic hoặc default.
- Với Tab-only: chưa đổi behavior cho đến khi PF-02 xác nhận contract thực tế.
```

## 3.3. File dự kiến ảnh hưởng

**Frontend**

* `FE-Audiomind/src/services/config.ts`
* `FE-Audiomind/src/hooks/useDualAudioRecorder.ts`
* `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`
* `FE-Audiomind/src/app/App.tsx`

**Backend**

* `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java`
* `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java`
* `packages/contracts/realtime-events.proto`

**Infrastructure**

* `infra/docker-compose.dev.yml`
* `infra/.env.example`

## 3.4. Giải pháp scope nhỏ

1. Xác minh runtime bundle FE đang bật `VITE_REALTIME_DUAL_STREAM_TAB_MIC`.
2. Xác minh Tab+Mic path thực sự gọi `useDualAudioRecorder`.
3. Xác minh `sendAudioChunk(..., streamId)` phát metadata đúng:

   * Tab stream: `stream_id=tab`
   * Mic stream: `stream_id=mic`
4. Với session Tab+Mic, backend chỉ chấp nhận stream_id = tab hoặc mic.
5. Với Tab+Mic nhận stream ID blank/unknown:
   * Log `REALTIME_INVALID_STREAM_ID`.
   * Reject/drop chunk hoặc mark invalid theo protocol hiện có.
   * Không fallback sang legacy `""`.
6. Với Tab-only, giữ behavior compatibility hiện tại cho đến khi contract đã được xác minh.
7. Transcript event giữ nguyên stream identity từ chunk đến FE merge và persistence.

## 3.5. Test cần viết trước

* FE unit: Tab+Mic bật flag thì đi qua dual recorder path.
* FE unit: Tab-only giữ flow đã được xác minh.
* FE/WebSocket test: tab stream gửi `stream_id=tab`.
* FE/WebSocket test: mic stream gửi `stream_id=mic`.
* Java test: Tab+Mic gửi blank/unknown stream ID bị reject/drop hoặc mark invalid, không fallback sang legacy "".
* Java regression: Tab-only vẫn giữ compatibility behavior hiện có nếu PF-02 xác nhận omit stream ID được hỗ trợ.
* Regression test: Tab-only không bị reject nếu contract cho phép omit stream ID.
* Smoke test end-to-end:

```text
FE recorder
→ WebSocket payload
→ backend parse
→ AI service/persistence
→ transcript event
→ FE merge
```

## 3.6. Rollback

```text
VITE_REALTIME_DUAL_STREAM_TAB_MIC=false
REALTIME_DUAL_STREAM_TAB_MIC_ENABLED=false
```

Sau đó rebuild FE image, restart processing-service và revert P1 patch nếu cần.

---

# 4. P2 – `segmentId` collide giữa tab và mic

## 4.1. Mục tiêu

Ngăn transcript tab và mic merge nhầm khi trùng `segmentId`, nhưng không tự thay đổi schema hoặc storage convention khi chưa có bằng chứng từ preflight.

## 4.2. Convention bắt buộc

### Storage convention

```text
- Giữ nguyên default storage hiện tại nếu schema/code dùng stream_id="" cho legacy.
- Không tự đổi DB default sang "default".
- Không persist "default" xuống DB nếu storage convention hiện tại là "".
- Migration chỉ được tạo khi PF-04/PF-05 xác nhận thực sự cần thiết.
```

### Identity/UI convention

```text
- FE merge key chuẩn:
  meetingId + streamId + segmentId

- Event legacy thiếu streamId:
  normalize thành "default" chỉ tại FE merge key hoặc identity helper.

- "default" chỉ tồn tại tại tầng identity/UI.
- "default" không phải FE audio stream ID.
- "default" không được ghi ngược xuống storage nếu storage legacy dùng "".
```

## 4.3. File dự kiến ảnh hưởng

**Frontend**

* `FE-Audiomind/src/utils/transcript.ts`
* `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`
* Components render transcript nếu đang dùng `segmentId` làm React key

**Backend/AI service**

* `MeetingWebSocketHandler.java`
* Event mapping
* STT persistence path nếu preflight xác nhận stream ID bị mất

**Database**

* Audit trước.
* Migration chỉ là conditional work item.

## 4.4. Giải pháp scope nhỏ

1. FE `resolveMergeKey` phải stream-aware kể cả khi event đã có `segmentId`.
2. FE không được merge hai segments khác stream chỉ vì cùng display ID.
3. Partial và final cùng identity phải update cùng transcript segment.
4. `SPEAKER_UNKNOWN → SPEAKER_1` không được tạo segment mới nếu identity không đổi.
5. Backend/AI service chỉ sửa nếu preflight chứng minh stream ID bị mất khi event hoặc persistence.
6. Không đụng migration nếu schema thực tế đã hỗ trợ stream identity.

## 4.5. Migration rule

Migration chỉ được phép đề xuất nếu ít nhất một điều kiện sau đúng:

* DB thật thiếu cột `stream_id`.
* Unique constraint hiện tại chặn hai transcript khác stream nhưng cùng `(meeting_id, segment_id)`.
* Query/export/history không thể phân biệt stream dù event và persistence đã có stream identity.

Nếu cần migration:

* Migration phải additive.
* Không đổi default `""` sang `"default"` nếu chưa có migration plan đầy đủ.
* Rollback bằng application code hoặc feature flag.
* Không drop dữ liệu mới khi rollback.

## 4.6. Test cần viết trước

* FE unit: hai events cùng `segmentId`, khác `streamId`, tạo hai transcript segments.
* FE unit: partial/final cùng stream merge đúng.
* FE unit: legacy event thiếu stream ID dùng fallback `"default"` tại identity layer.
* FE regression: speaker resolution update đúng segment thay vì append duplicate.
* FE regression: `"default"` không bị ghi ngược xuống persistence payload.
* Backend/AI integration: persisted transcript giữ stream identity nếu preflight xác nhận path này cần sửa.
* Export/history regression nếu PF-05 phát hiện dependency.

## 4.7. Rollback

* Tắt dual-stream feature flag.
* Revert FE merge-key patch nếu UI lỗi.
* Revert backend event enrichment nếu event contract lỗi.
* Nếu đã có migration additive, không rollback bằng cách xóa data.

---

# 5. P3 – Transcript đã persist nhưng analysis bị skip

## 5.1. Mục tiêu

Nếu transcript cuối cùng có text non-blank, meeting không được chuyển sang `FAILED_AUDIO_CAPTURE` chỉ vì heuristic audio capture. Analysis phải chạy qua existing async path.

## 5.2. Fact đã xác minh

* `triggerRealtimeAnalysisAsync(...)` đã chạy async bằng `CompletableFuture.runAsync(...)`.
* `runRealtimeAnalysis(...)` fetch transcript, build transcript text, compute hash và gọi `jobStateStore.tryStartAnalysis(...)`.
* `tryStartAnalysis(...)` đã có lock/state cho running, completed, retryable failed hoặc cooldown.
* `recoverTranscriptAfterTerminalFinalize(...)` đã có logic recovery transcript và có thể trigger realtime analysis khi transcript non-blank.

## 5.3. Defect đã xác minh: thứ tự recovery và terminal failure

CodeGraph đã xác minh `finalizeSttSession(...)` hiện có hai nhánh terminal fail sớm:

```text
!audioReceived
→ completeTerminalRealtimeOutcome(... FAILED_AUDIO_CAPTURE ...)
→ return

isInvalidAudioCapture(...)
→ completeTerminalRealtimeOutcome(... FAILED_AUDIO_CAPTURE ...)
→ return
```

Trong hai nhánh này, `recoverTranscriptAfterTerminalFinalize(...)` không được gọi trước khi meeting bị đánh dấu `FAILED_AUDIO_CAPTURE`. Đây là root defect cần sửa bằng local reorder/reuse helper, không phải bằng state machine mới ở phase đầu.

Thứ tự bắt buộc sau khi implement P3:

```text
Finalize detects potentially invalid capture
→ recovery/check transcript
→ transcript text non-blank?
   → yes: triggerRealtimeAnalysisAsync(...)
           do not mark FAILED_AUDIO_CAPTURE
   → no: only then mark FAILED_AUDIO_CAPTURE
```

Không được dùng flow:

```text
Finalize
→ mark FAILED_AUDIO_CAPTURE
→ recovery chạy sau
→ transcript có text nhưng meeting vẫn terminal failed
```

Nếu method recovery hiện tại đang chạy sau terminal failure, local fix phải:

1. Gọi recovery trước update terminal status, hoặc
2. Tách phần recovery thành helper chạy trước terminal decision.

Không được xây state machine mới ở phase đầu nếu local reorder/reuse path hiện có giải quyết được lỗi.

## 5.4. Giải pháp scope nhỏ

```text
Trước khi mark FAILED_AUDIO_CAPTURE:
→ gọi recovery/check transcript hiện có
→ chỉ coi recovery thành công khi transcript text non-blank
→ nếu transcript hợp lệ, gọi existing triggerRealtimeAnalysisAsync(...)
→ verify/harden idempotency hiện có tại tryStartAnalysis(...)
→ chỉ mark FAILED_AUDIO_CAPTURE khi recovery không tìm thấy transcript hợp lệ
```

Điều kiện transcript hợp lệ:

```text
text != null
AND text.trim().isEmpty() == false
```

Không đề xuất `Thread.sleep()` trong WebSocket handler. Nếu cần đợi STT persistence flush:

* Dùng existing async recovery path.
* Hoặc retry bounded ở async executor/finalize deadline service.
* Không block realtime WebSocket thread.

## 5.5. Idempotency cần xác minh

Cần test rõ:

* Duplicate finalize.
* Reconnect.
* Recovery chạy nhiều lần.
* Transcript hash giống nhau.
* Analysis đang running.
* Analysis đã completed.
* Retryable failed hoặc cooldown.

Mục tiêu:

```text
Một meeting + một transcript version
→ không tạo nhiều analysis jobs trùng nhau.
```

## 5.6. Analysis API 404 và source of truth

Không khẳng định AI service phải tự biết meeting có tồn tại, vì AI service có thể chỉ biết transcript hoặc analysis row.

Source of truth đề xuất cho FE là processing-service vì FE gọi `/processing/{meetingId}/analysis`, `ProcessingController.analysis(...)` delegate sang `ProcessingService.getAnalysisInternal(...)`, và service này biết meeting access, job state, AI fallback và lazy trigger.

Sau preflight phải chốt exact response contract trong processing-service như sau:

| Trạng thái                               | FE phải nhận             |
| ---------------------------------------- | ------------------------ |
| Meeting không tồn tại thật               | 404                      |
| Meeting tồn tại, chưa có analysis row    | NOT_STARTED hoặc PENDING |
| Transcript đã có, analysis chuẩn bị chạy | PENDING                  |
| Analysis đang chạy                       | RUNNING                  |
| Gemini/all keys unavailable có thể retry | RETRYABLE_FAILED         |
| Analysis hoàn tất                        | SUCCEEDED                |
| Lỗi không retry được                     | FAILED                   |

Không để FE nhận `404` liên tục khi meeting/transcript tồn tại và system vẫn đang xử lý analysis.

## 5.7. Test cần viết trước

* Java unit: invalid audio heuristic nhưng recovery trả transcript non-blank thì không mark `FAILED_AUDIO_CAPTURE`.
* Java unit: transcript row tồn tại nhưng text blank thì không coi recovery thành công.
* Java unit: transcript empty sau recovery thì meeting terminal fail/no-transcript theo policy.
* Java unit: recovery được gọi trước terminal status update.
* Java unit: duplicate finalize/reconnect không tạo nhiều analysis jobs.
* Java unit: verify decision của `tryStartAnalysis(...)`.
* Integration/API: transcript đã persist nhưng chưa có analysis row thì FE không bị kẹt `404`.
* API: pending/running/retryable failed/succeeded phản hồi đúng owner contract.
* API: meeting không tồn tại thật vẫn trả not found.

## 5.8. Follow-up / Future hardening

Chỉ thực hiện nếu local fix không giải quyết được race condition:

```text
FINALIZING
→ TRANSCRIPT_RECOVERING
→ ANALYSIS_QUEUED
→ ANALYSIS_RUNNING
→ COMPLETED
```

Follow-up có thể bao gồm:

* State machine finalize rõ ràng.
* Analysis status tách riêng khỏi meeting status.
* Recovery job riêng có bounded retry/backoff.
* Persisted analysis job state cho recovery sau restart.

Các hạng mục này không chặn P1/P2/P3/P5 phase đầu.

## 5.9. Rollback

```text
REALTIME_RECOVER_BEFORE_FAIL=false
```

Nếu flag chưa tồn tại, thêm flag nhỏ trong phase implementation. Rollback nhanh là tắt flag hoặc revert P3 patch. Không cần rollback DB.

---

# 6. P5 – Tiny chunks gây `FAILED_AUDIO_CAPTURE` sai

## 6.1. Mục tiêu

Tiny chunks là tín hiệu yếu. Chúng không được override transcript đã persist hoặc valid audio đã nhận trước đó.

## 6.2. Rule terminal failure

Meeting chỉ fail vì tiny chunk khi đồng thời thỏa tất cả điều kiện:

```text
- Tất cả stream đều tiny hoặc invalid.
- Không có valid audio chunks.
- Không có transcript text non-blank sau recovery.
- Không có stream healthy.
- Recovery transcript thất bại hoặc không có transcript.
```

Các trường hợp không được fail sai:

```text
- Mic muted/tiny nhưng tab có transcript.
- Tab valid nhưng mic tiny.
- Tiny chunks xuất hiện sau valid audio.
- Tiny tail xuất hiện sau transcript.
```

## 6.3. Scope nhỏ

1. Audit `isInvalidAudioCapture(...)` và stream-level audio state hiện có.
2. Không query DB trên từng tiny chunk.
3. Chỉ dùng transcript recovery ở finalize/P3 như lớp bảo vệ cuối.
4. Nếu cần thêm state, giữ tối thiểu:

   * Has valid audio.
   * Has transcript text.
   * Stream healthy.
   * Tiny streak per stream nếu code hiện hỗ trợ.
5. Không thiết kế lại toàn bộ audio pipeline.

## 6.4. Test cần viết trước

* Mic tiny nhưng tab valid: meeting không fail.
* Tab valid, mic tiny: meeting không fail và analysis vẫn trigger.
* Tiny tail sau transcript: meeting không fail.
* Tiny-only, không transcript, không valid audio: meeting fail theo policy.
* Dual-stream một stream mute, một stream transcript hợp lệ: analysis queue.
* Tiny chunk storm không gây DB query liên tục trong hot path.

## 6.5. Rollback

```text
REALTIME_IGNORE_TINY_AFTER_TRANSCRIPT=false
```

Nếu flag chưa tồn tại, thêm flag nhỏ khi implement. Có thể rollback bằng revert P5 patch.

---

# 7. P4a – Required Fix: Gemini retry/failover runtime behavior

## 7.1. Mục tiêu

Wiring `GEMINI_RETRY_QUOTA_EXCEEDED` từ settings vào analyzer đã được xác minh ở code. P4a không nên mặc định rewrite config path.

Mục tiêu P4a là xác minh và harden runtime behavior:

* Primary key 429 có thực sự thử backup key khi enabled và backup healthy.
* All keys exhausted có trả retryable failure/cooldown metadata rõ ràng.
* Invalid/auth key không bị retry vô hạn.
* Retry/failover result propagate đúng về analysis job status và FE-facing processing-service response.

## 7.2. File dự kiến ảnh hưởng

* `demoRecordAUDIOMID/ai-service/app/config.py`
* `demoRecordAUDIOMID/ai-service/app/services/ai_analyzer.py`
* Gemini client/key manager files nếu runtime behavior test xác nhận còn gap
* `infra/.env.example`
* `infra/docker-compose.dev.yml`

## 7.3. Behavior bắt buộc

```text
Nếu GEMINI_RETRY_QUOTA_EXCEEDED=false:
→ giữ behavior hiện tại, không kích hoạt retry quota path mới.

Nếu GEMINI_RETRY_QUOTA_EXCEEDED=true
và GEMINI_MULTI_KEY_ENABLED=true
và backup key healthy:
→ thử backup key theo retry policy giới hạn.

Nếu không còn key healthy:
→ trả retryable failure/cooldown metadata rõ ràng.

Nếu key invalid hoặc authentication failed:
→ không retry vô hạn key đó.

Không log API key hoặc secret.
Chỉ log alias hoặc fingerprint ngắn.
```

## 7.4. Scope required

1. Giữ wiring config hiện có nếu tests xác nhận không có regression.
2. Primary key 429 thử backup key nếu policy và backup key cho phép.
3. All keys exhausted trả retryable failure/cooldown metadata.
4. Invalid/auth key không retry vô hạn.
5. Analysis job/status phản ánh đúng retryable failure thay vì kẹt generic failed/404.
6. Không triển khai Redis, distributed circuit breaker hoặc multi-instance coordination trong P4a.

## 7.5. Test cần viết trước

* Regression config test: `GEMINI_RETRY_QUOTA_EXCEEDED=true` tạo settings true.
* Regression factory/analyzer test: analyzer/client nhận `retry_quota_exceeded=true`.
* Gemini test: primary key 429 và backup key healthy thì backup được thử.
* Gemini test: all keys exhausted trả retryable failure/cooldown metadata.
* Regression: invalid/auth key không retry vô hạn.
* Regression: retry disabled giữ behavior hiện tại.

## 7.6. Rollback

```text
GEMINI_RETRY_QUOTA_EXCEEDED=false
GEMINI_MULTI_KEY_ENABLED=false
```

Nếu retry gây backlog, tắt flags hoặc revert P4a patch.

---

# 8. P4b – Follow-up Hardening: Circuit Breaker và Shared Cooldown

P4b không chặn P1/P2/P3/P5/P4a.

## 8.1. Mục tiêu

Tăng độ bền khi mọi Gemini key unavailable trong thời gian dài hoặc khi nhiều AI-service instances cùng hoạt động.

## 8.2. Hạng mục follow-up

* Circuit breaker khi all keys exhausted.
* Shared cooldown bằng Redis hoặc shared persistence.
* Multi-instance coordination.
* Retry queue control.
* Metrics mở rộng:

```text
gemini_key_429_total
gemini_key_cooldown_active
gemini_all_keys_exhausted_total
gemini_circuit_open_total
gemini_retry_success_total
```

## 8.3. Rollback

```text
GEMINI_CIRCUIT_BREAKER_ENABLED=false
GEMINI_SHARED_COOLDOWN_ENABLED=false
```

---

# 9. Thứ tự triển khai

## Phase 0 – Technical Preflight

1. Xác minh runtime payload Tab+Mic theo chuỗi đầy đủ.
2. Xác minh contract Tab-only.
3. Xác minh invalid stream ID behavior.
4. Audit schema, constraint, query/export/history của `stream_id`.
5. Xác minh thứ tự recovery và `FAILED_AUDIO_CAPTURE`.
6. Chốt processing-service response contract cho analysis status API.
7. Xác minh Gemini retry/failover runtime behavior.
8. Xác minh tên test commands thực tế.

## Phase 1 – P1

1. Bật đúng dual-stream path.
2. Validate Tab+Mic chỉ nhận `tab|mic`.
3. Reject/drop invalid stream ID, không fallback.
4. Log stream payload và transcript stream identity.

## Phase 2 – P2

1. FE merge key stream-aware.
2. Legacy fallback `"default"` chỉ ở identity layer.
3. Không persist `"default"` xuống storage legacy.
4. Backend/persistence chỉ sửa nếu preflight cho thấy mất stream identity.
5. Migration chỉ thực hiện nếu preflight xác nhận thật sự cần.

## Phase 3 – P3 + P5

1. Recovery transcript chạy trước terminal `FAILED_AUDIO_CAPTURE`.
2. Reuse `triggerRealtimeAnalysisAsync(...)`.
3. Verify/harden `tryStartAnalysis(...)`.
4. Tiny chunk không override transcript hoặc valid stream.
5. Sửa processing-service analysis status contract để FE không mắc kẹt `404`.

## Phase 4 – P4a

1. Runtime behavior tests cho primary 429, backup key và invalid/auth key.
2. Patch retry/failover gaps nếu tests chứng minh còn lỗi.
3. Retryable failure metadata propagate tới analysis job/status.

## Phase 5 – P4b Follow-up

Circuit breaker, shared cooldown và multi-instance coordination nếu cần.

---

# 10. Smoke Test Bắt Buộc

| Scenario                                           | Kết quả mong đợi                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Tab-only recording                                 | Transcript và analysis hoạt động bình thường theo contract đã chốt           |
| Tab+Mic recording                                  | Payload có `stream_id=tab` và `stream_id=mic`; transcript không overwrite    |
| Tab+Mic invalid stream ID                          | Chunk bị reject/drop, không fallback stream                                  |
| Mic mute, tab valid                                | Meeting không fail sai; analysis pending/running hoặc completed              |
| Tab valid, mic tiny                                | Meeting không fail vì mic tiny                                               |
| `segmentId` trùng nhưng khác `streamId`            | Không merge transcript sai                                                   |
| Legacy event thiếu `streamId`                      | FE merge dùng fallback `"default"` nhưng không persist fallback xuống DB     |
| Reconnect/duplicate event                          | Không duplicate transcript hoặc analysis job                                 |
| Transcript persisted nhưng finalize heuristic fail | Recovery tìm transcript và trigger existing analysis path                    |
| Analysis pending                                   | FE không mắc kẹt ở `404` sau khi transcript đã persist                       |
| Gemini primary key 429                             | Backup key được thử khi enabled và healthy; nếu không thì retryable metadata |
| Tiny-only, không audio/text                        | Terminal failed/no-transcript theo policy hiện có                            |

---

# 11. Checklist Trước Khi Merge

## Tổng quát

* [ ] Technical Preflight blocker đã pass.
* [ ] Không implement production code trước khi preflight pass.
* [ ] Correlation fields được log đủ: `meetingId`, `sessionId`, `streamId`, `segmentId`, `analysisRequestId` nếu có.
* [ ] Không log API key hoặc secret.
* [ ] Không block WebSocket thread.
* [ ] Không tự đổi storage convention `stream_id`.
* [ ] Không đưa `"default"` vào FE audio stream enum.
* [ ] Không persist `"default"` xuống DB nếu legacy storage dùng `""`.
* [ ] Legacy transcript vẫn hoạt động.

## P1

* [ ] Runtime payload Tab+Mic được xác nhận.
* [ ] `streamId=tab` và `streamId=mic` đi xuyên suốt pipeline.
* [ ] Backend validate theo session mode.
* [ ] Invalid stream ID bị reject/drop, không fallback.
* [ ] Tab-only contract đã được chốt.

## P2

* [ ] FE identity chuẩn là `meetingId + streamId + segmentId`.
* [ ] Legacy fallback `"default"` chỉ ở identity/merge layer.
* [ ] Migration chỉ được viết nếu preflight xác nhận cần.
* [ ] Export/history không bị ảnh hưởng hoặc đã có regression test.

## P3 + P5

* [ ] Recovery chạy trước terminal `FAILED_AUDIO_CAPTURE`.
* [ ] Transcript text non-blank thắng tiny heuristic.
* [ ] `triggerRealtimeAnalysisAsync(...)` được reuse.
* [ ] `tryStartAnalysis(...)` idempotency được verify/harden.
* [ ] Duplicate finalize/reconnect không tạo duplicate analysis job.
* [ ] Tiny chunks không query DB liên tục trong hot path.
* [ ] API owner đã được chọn và FE không mắc kẹt 404.

## P4a/P4b

* [ ] P4a retry config wiring được giữ bằng regression test.
* [ ] P4a backup key runtime behavior được test.
* [ ] All keys exhausted có retryable metadata rõ ràng.
* [ ] Invalid/auth key không retry vô hạn.
* [ ] P4b không chặn core realtime release.

---

# 12. Lệnh Test và Deploy Tham Khảo

Các lệnh dưới đây dùng chuẩn `rtk test`. Nếu test file hoặc class đổi tên, coi là candidate command cần xác minh trong Phase 0.

```bash
# Frontend transcript tests
rtk test npm --prefix FE-Audiomind test -- --run src/utils/transcript.test.ts

# Frontend realtime tests
rtk test npm --prefix FE-Audiomind test -- --run src/hooks/useRealtimeMeetingStream.test.tsx

# Java WebSocket tests
rtk test .\mvnw.cmd -pl processing-service -Dtest=MeetingWebSocketHandlerTest test

# Java processing analysis/API tests
rtk test .\mvnw.cmd -pl processing-service -Dtest=ProcessingServiceTest test

# Python Gemini tests
rtk test pytest demoRecordAUDIOMID/ai-service/tests/test_gemini_key_manager.py -q

# Candidate: Python analysis endpoint tests
rtk test pytest demoRecordAUDIOMID/ai-service/tests/test_analysis_runs.py -q

# Rebuild frontend
rtk docker compose -f infra/docker-compose.dev.yml --env-file infra/.env build web

# Restart services
rtk docker compose -f infra/docker-compose.dev.yml --env-file infra/.env up -d web processing-service ai-service

# Check logs
rtk docker compose -f infra/docker-compose.dev.yml --env-file infra/.env logs --tail=300
```

---

# 13. Kết luận

Plan này là:

```text
Draft - Pending Technical Preflight
```

Plan chưa được gọi là “ready to implement” tuyệt đối cho đến khi các preflight blocker pass, đặc biệt là:

```text
1. Runtime Tab+Mic stream_id thực tế.
2. Thứ tự recovery trước FAILED_AUDIO_CAPTURE.
3. DB storage/constraint stream_id.
4. Processing-service analysis status contract.
5. Gemini retry/failover runtime behavior.
```

Sau khi các blocker pass, scope implement ưu tiên là:

```text
P1: Xác minh và validate stream_id runtime.
P2: FE transcript merge stream-aware.
P3 + P5: Recovery transcript trước terminal failure,
          reuse existing analysis async path,
          tiny chunks không override transcript hợp lệ.
P4a: Test và harden Gemini retry/failover runtime behavior.
```

P4b và state machine finalize đầy đủ là hardening follow-up, không được chặn bản sửa lỗi core.
