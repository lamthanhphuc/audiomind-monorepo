# Phase 4 Spec: Realtime Live Segment-Level Transcript Events

## 1. Problem Statement

Trong luong ghi am realtime hien tai, UI thuong chi hien thi 1 live segment dai trong suot qua trinh recording.

Sau khi stop va chay hydration (tai transcript da luu), transcript hien thi duoc nhieu segment tot hon.

He qua:
- Trải nghiem realtime khong phan manh theo cau/segment theo thoi gian.
- Kho quan sat tien trinh hoi thoai khi dang ghi am.
- FE phai dua vao hydration sau stop de co transcript chia segment ro rang hon.

## 2. Current Flow

### ai-service

- Deepgram adapter parse duoc transcript event voi cac truong quan trong nhu `segment_id`, `start_time`, `end_time`, `is_final`, va co the co `speaker`.
- Trong luong realtime STT actor, response tra nguoc cho processing hien tai chua luon giu du segment-level fields cho moi event realtime.
- Ket qua la payload ve processing co luc mang tinh aggregate/last fragment thay vi segment-level contract on dinh.

### processing-service

- WebSocket handler nhan audio chunk metadata + binary, goi ai-service endpoint stream de lay transcript theo chunk.
- Handler build va broadcast event `transcript.partial` hoac `transcript.final` cho FE.
- Khi thieu `segmentId` that, processing fallback sinh `segmentId` tu `startTime` hoac `seq`.

### FE

- Hook realtime nhan message websocket (`transcript.partial`/`transcript.final`) va dua qua normalize + upsert.
- Upsert transcript co co che merge identity va fallback semantic.
- Khi ID khong on dinh (dac biet seq-based), FE co xu huong merge vao cung 1 live segment thay vi tao nhieu segment theo thoi gian.

## 3. Root Cause

- Thieu stable segment identity va timing day du trong realtime stream response giua ai-service -> processing-service -> FE.
- processing-service fallback seq-based segmentId trong mot so nhanh.
- FE coi seq-style IDs la unstable, dan den merge/upsert ve mot segment song duy nhat.

## 4. Target Event Contract

Hai event contract can thong nhat cho realtime transcript:

### transcript.partial

```json
{
  "type": "transcript.partial",
  "meetingId": 123,
  "segmentId": "123-12.340-15.670",
  "speaker": "SPEAKER_1",
  "text": "...",
  "startTime": 12.34,
  "endTime": 15.67,
  "isFinal": false
}
```

### transcript.final

```json
{
  "type": "transcript.final",
  "meetingId": 123,
  "segmentId": "123-12.340-15.670",
  "speaker": "SPEAKER_1",
  "text": "...",
  "startTime": 12.34,
  "endTime": 15.67,
  "isFinal": true
}
```

Ghi chu contract:
- `segmentId` la identity key de upsert.
- `startTime` va `endTime` la timing metadata de render, khong phai luc nao cung la identity key.
- `isFinal` la finality flag, dung cho guard out-of-order va chong downgrade.

## 4.1 Single Event vs Multiple Events per Chunk

Thuc te runtime:
- ai-service co the nhan nhieu Deepgram transcript events trong mot audio chunk.

Hai huong contract:
- Huong A: ai-service tra `segments: []` trong mot response chunk.
- Huong B: ai-service van tra event don, nhung actor/processing phat tung websocket segment event rieng.

Khuyen nghi cho repo hien tai:
- Chon Huong B de giam rui ro thay doi API surface lon.
- Ly do:
  - Processing websocket flow hien tai da orient theo event-based broadcast.
  - FE hook hien tai da xu ly message-based upsert tot.
  - It phat sinh breaking change o hop dong endpoint stream hien co.

- Neu can gom nhieu segments trong backend queue noi bo, van emit ra websocket theo tung segment event de FE de xu ly ordering/upsert.

## 5. Segment ID Rules

- Uu tien `segment_id` goc tu ai-service/Deepgram neu co.
- Rui ro neu identity dua vao `endTime`:
  - `endTime` cua partial thuong thay doi theo thoi gian.
  - Neu dua `endTime` vao identity, partial update co the tao `segmentId` moi.
  - He qua: duplicate segment trong live UI.
- Fallback deterministic khi thieu ID:
  - Uu tien: `segmentId = <meetingId>-<startTime_rounded_3>-<speaker_or_unknown>-<localUtteranceIndex_if_any>`
  - Khong dung `endTime` mutable lam identity chinh cho partial neu con lua chon tot hon.
  - `endTime` duoc xem la metadata cap nhat theo thoi gian.
  - Neu bat buoc dung `endTime` fallback thi uu tien cho final hoac segment da on dinh.
- Khong dung `seq` lam segmentId chinh cho transcript event.
- Partial va final cua cung mot segment bat buoc dung cung `segmentId`.
- Segment ID phai on dinh qua nhieu ban tin cap nhat partial -> final.

## 5.1 Missing Metadata Fallback Rules

- `speaker` missing:
  - Co the de `null` trong backend contract.
  - FE duoc phep fallback hien thi `SPEAKER_1` de tranh crash/blank UI.
- `startTime`/`endTime` missing:
  - Van cho phep event di tiep, nhung phai co fallback render an toan o FE.
  - Bat buoc ghi warning log de theo doi chat luong du lieu.
- `segmentId` missing hoan toan:
  - Tao temporary ID (tam thoi) de khong danh roi event.
  - Bat buoc log warning.
  - Temporary ID khong duoc dung de persist final neu sau do co stable ID.
  - Khi stable ID xuat hien, can co quy tac remap/upgrade thay vi tao duplicate.

## 5.2 Event Ordering Rules

- Partial cung `segmentId`:
  - Replace/update text va timing in-place.
- Final cung `segmentId`:
  - Upgrade partial thanh final.
- Final khong duoc bi partial cu overwrite.
- Event out-of-order:
  - Guard bang `isFinal` va metadata ordering (`updatedAt` hoac `sequence`) neu co.
- Duplicate event:
  - Cung `segmentId` va cung `text` thi ignore.
- Neu stale partial den sau final:
  - Khong downgrade final state.

## 6. Implementation Phases

### Phase 4.1 - ai-service event contract

- SttStreamResponse can them/giu day du cac truong:
  - `segment_id`
  - `start_time`
  - `end_time`
  - `speaker`
  - `is_final`
- SttSessionActor can tra response theo segment-level thay vi mat metadata timing/identity.
- Xu ly truong hop nhieu Deepgram events trong 1 chunk:
  - Dam bao actor co the emit du segment-level events (hoac queue noi bo) ma khong mat identity.
- Dam bao partial `end_time` thay doi nhung `segment_id` van on dinh cho cung segment.
- Dam bao final giu cung `segment_id` voi partial tuong ung.

### Phase 4.2 - processing-service broadcast

- Map day du field tu ai-service sang websocket events `transcript.partial`/`transcript.final`.
- Khong fallback `seq` neu da co `segmentId` that.
- Dam bao final event giu dung `segmentId` cua partial cung segment.
- Neu backend noi bo co `segments[]`, map thanh nhieu websocket events theo thu tu hop le.
- Duong dan `reset_required` tiep tuc giu nguyen hanh vi dang on dinh.

### Phase 4.3 - FE upsert

- Upsert transcript theo `segmentId` la key chinh.
- Partial update in-place tren segment da ton tai.
- Final replace/upgrade partial cung `segmentId`.
- Tranh duplicate segment khi nhan nhieu partial updates.
- Partial den sau final khong duoc lam mat trang thai final.
- Event duplicate cung identity + cung text duoc bo qua.

### Phase 4.4 - tests

- ai-service tests:
  - Deepgram emits 2 events in one chunk -> actor expose 2 segment events hoac co `segments[]` noi bo.
  - Partial segment `endTime` thay doi nhung `segmentId` van on dinh.
  - Final event giu cung `segmentId` voi partial.
- processing-service websocket tests:
  - Map `segments[]` (neu co) thanh nhieu websocket events dung thu tu.
  - Khong dung `seq` lam `segmentId` khi co segment metadata.
  - Duong dan `reset_required` van hoat dong dung.
- FE tests:
  - Partial update cung `segmentId` in-place.
  - Final upgrade partial.
  - Partial den sau final khong downgrade final.
  - Dang recording render duoc nhieu live segments.
  - Missing speaker/timing khong lam crash UI.
- Regression Phase 3.1:
  - reset_required handling
  - partial finalization
  - hydration stable polling
  - transcript partial warning
  - realtime startup/session token lifecycle

## 7. Acceptance Criteria

- Recording 20-30s, UI hien thi nhieu live segments theo thoi gian.
- Partial updates khong tao duplicate.
- Final replace partial cung segment.
- Khi Deepgram co segment boundaries, recording 20-30s hien thi it nhat 3 live segments.
- Khong duplicate segment khi partial `endTime` thay doi.
- Final segment giu final state ngay ca khi stale partial den sau.
- Stop/hydration van hoat dong on dinh.
- Reset-required/partial warning van dung.
- Test set cua Phase 3.1 tiep tuc pass.

## 8. Risks

- unstable segmentId
- duplicate segment
- partial overwriting final sai
- missing speaker
- missing timing
- breaking reset-required flow

## 9. Validation Plan

- FE focused tests/build.
- ai-service realtime parser/session tests.
- processing websocket broadcast tests.
- Regression Phase 3.1 end-to-end/targeted suites.

## 10. Runtime Logs

De xac minh luong runtime va debug nhanh, de xuat them cac log marker sau:

- `LIVE_SEGMENT_EVENT_CREATED`
- `LIVE_SEGMENT_EVENT_MISSING_TIMING`
- `LIVE_SEGMENT_BROADCAST`
- `LIVE_SEGMENT_UPSERT`
- `LIVE_SEGMENT_FINAL_UPGRADE`
- `LIVE_SEGMENT_DUPLICATE_IGNORED`

Nguyen tac log:
- Khong log payload nhay cam.
- Log du identity/timing/state de truy vet ordering va duplicate.

## 11. Phase 3.1 Regression Protection

Phase 4 khong duoc pha cac hanh vi da on dinh:

- reset_required handling
- partial finalization
- hydration stable polling
- transcript partial warning
- realtime startup/session token lifecycle

## Out of Scope (for this spec step)

- Khong implement code runtime.
- Khong thay doi business logic ngoai pham vi event contract realtime segment-level.
- Khong commit/push trong buoc tao spec.
