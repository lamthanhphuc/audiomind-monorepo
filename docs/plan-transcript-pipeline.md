# Plan Transcript Pipeline for AudioMind

## 1. Hiện trạng luồng dữ liệu

### `MeetingWebSocketHandler.java`

File: [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java)

Luồng hiện tại:

1. Khi WebSocket kết nối được thiết lập, handler lấy `meetingId` từ session, đăng ký session vào `RealtimeEventSubscriber`, rồi gửi event `session.ready` cho frontend.
2. Khi nhận `auth.init`, handler xác thực JWT và đánh dấu session là đã authenticated.
3. Khi nhận message JSON `audio.chunk`, handler chỉ lưu metadata như `seq`, `size`, `ts_ms` vào session attributes.
4. Sau đó handler trả về một event placeholder `transcript.partial` với text cố định `Audio received`.
5. Khi nhận binary audio, handler chỉ log kích thước payload và tiếp tục trả `transcript.partial` với nội dung kiểu `Processed X bytes of audio`.

Kết luận: luồng WebSocket đã đúng về mặt transport, nhưng chưa có bước chuyển audio sang STT thật. Hiện backend chỉ xác nhận đã nhận audio, không xử lý ngôn ngữ nói.

### `RealtimeEventSubscriber.java`

File: [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/services/RealtimeEventSubscriber.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/services/RealtimeEventSubscriber.java)

Luồng hiện tại:

1. Service giữ danh sách WebSocket session theo `meetingId` bằng `ConcurrentHashMap` và `CopyOnWriteArrayList`.
2. `registerSession()` và `unregisterSession()` quản lý vòng đời kết nối theo cuộc họp.
3. `broadcastToMeeting()` serialize event thành JSON rồi gửi cho tất cả session còn mở.
4. `handleTranscriptEvent()` và `handleKeywordEvent()` chỉ là lớp chuyển đổi payload từ Redis Stream sang event ứng dụng rồi broadcast qua WebSocket.
5. Phần subscribe Redis stream vẫn là placeholder, chưa có consumer hoàn chỉnh trong file này.

Kết luận: đây là lớp phát tán realtime event ra frontend, không phải nơi thực hiện STT. Nếu có transcript thật, service này sẽ là điểm broadcast kết quả cuối cùng.

### `stt_adapter.py`

File: [demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py](../demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py)

Luồng hiện có:

1. `DeepgramSTTAdapter` cung cấp giao diện `open_session()`, `push_audio_chunk()`, `close_session()` để stream PCM tới Deepgram qua WebSocket.
2. Adapter dựng URL kết nối với tham số `model`, `language`, `encoding=linear16`, `sample_rate`, `interim_results=true`, `utterances=true`.
3. Mỗi audio chunk được gửi đi ngay, rồi adapter đọc các message transcript trả về, gom partial/final event vào session buffer.
4. Khi đóng session, adapter flush các event còn lại và trả về transcript tổng hợp.

Kết luận: ai-service đã có sẵn một STT streaming adapter phù hợp cho real-time transcript. Điểm còn thiếu là phía Java backend chưa gọi vào adapter này.

### `speech_recognizer.py`

File: [demoRecordAUDIOMID/ai-service/app/services/speech_recognizer.py](../demoRecordAUDIOMID/ai-service/app/services/speech_recognizer.py)

Luồng hiện có:

1. `SpeechRecognizer` load Whisper model local từ `/app/models`.
2. `transcribe()` xử lý audio file dài bằng cách chia chunk, transcribe từng phần, rồi merge segment text.
3. `transcribe_segment()` nhận numpy audio segment, chuẩn hóa, pad/trim 30 giây và transcribe trực tiếp.
4. Có fallback decoding khi một số path Whisper fail trong quá trình giải mã.

Kết luận: đây là đường STT local/offline có thể dùng cho batch hoặc xử lý hậu kỳ. Nó không phải pipeline streaming real-time tối ưu cho WebSocket hiện tại.

## 2. Ba phương án để có transcript thực sự

| Phương án | Mô tả | Ưu điểm | Nhược điểm | Độ phức tạp |
|:---|:---|:---|:---|:---:|
| A | Gọi trực tiếp Whisper service từ `MeetingWebSocketHandler` | Không phụ thuộc dịch vụ ngoài, dễ hiểu về mặt kiến trúc | Blocking, latency cao, khó giữ trải nghiệm realtime, dễ gây nghẽn thread WebSocket | Thấp |
| B | Đẩy audio chunk vào Redis queue, worker xử lý, broadcast kết quả qua Redis pub/sub | Không blocking, scale ngang tốt, tách biệt ingest và STT | Cần thêm queue, worker, retry, idempotency, observability và vận hành phức tạp hơn | Cao |
| C | Tận dụng Deepgram API qua STT adapter đã có | Có streaming transcript thật, latency thấp, thay đổi code nhỏ nhất, phù hợp realtime | Phụ thuộc API ngoài, cần quản lý key/chi phí/egress | Trung bình |

### Đánh giá nhanh

Nếu mục tiêu là có transcript thật nhanh nhất với rủi ro thấp nhất về tích hợp, phương án C là tối ưu. Lý do chính là adapter Deepgram đã tồn tại sẵn trong ai-service, có đủ primitive cho session streaming và partial/final transcript. Phương án A chỉ phù hợp làm proof-of-concept hoặc fallback offline. Phương án B là kiến trúc tốt nhất khi cần scale lớn và kiểm soát dữ liệu hoàn toàn trong nội bộ, nhưng nó kéo theo thêm nhiều thành phần hạ tầng và sẽ làm chậm thời gian ra kết quả.

## 3. Phương án được chọn: C - Deepgram qua STT adapter

### Lý do chọn

1. Có thể biến placeholder transcript thành transcript thật với ít thay đổi nhất ở backend hiện tại.
2. Giữ được trải nghiệm realtime vì Deepgram adapter đang stream chunk và trả interim/final transcript.
3. Tận dụng được `stt_adapter.py` thay vì viết lại một pipeline STT mới từ đầu.
4. Vẫn có thể mở đường cho phương án B sau này nếu cần self-host hoặc tối ưu chi phí.

### Các file cần sửa hoặc thêm

#### Cần sửa

- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/services/RealtimeEventSubscriber.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/services/RealtimeEventSubscriber.java)
- File cấu hình của processing-service để khai báo endpoint ai-service, API key, language mặc định, timeout và feature flag cho STT realtime.

#### Cần thêm hoặc mở rộng

- Một client/service trung gian để gọi ai-service STT endpoint từ Java backend.
- DTO/event contract cho transcript partial/final nếu hiện chưa có schema ổn định.
- Nếu muốn trace end-to-end, bổ sung logging correlation theo `meetingId` và `seq`.

### Luồng dữ liệu chi tiết đề xuất

1. Frontend gửi `auth.init`, rồi gửi `audio.chunk` metadata và binary audio như hiện tại.
2. `MeetingWebSocketHandler` không còn trả placeholder text nữa, mà chỉ giữ metadata, correlation id và trạng thái phiên.
3. Khi binary audio tới, handler chuyển chunk sang STT service hoặc ai-service adapter theo một API nội bộ.
4. ai-service mở một STT session tương ứng với `meetingId` và `language`.
5. Mỗi binary chunk được stream vào Deepgram adapter.
6. Adapter trả về partial transcript liên tục, final transcript khi nhận đủ ngữ cảnh hoặc kết thúc utterance.
7. Kết quả transcript được đẩy về `RealtimeEventSubscriber.broadcastToMeeting()` để frontend nhận realtime event chuẩn hóa như `transcript.partial` và `transcript.final`.
8. Nếu transcription fail, backend cần phát event lỗi có kiểm soát để frontend biết fallback sang trạng thái degraded.

### Cách cấu hình và build

1. Cấu hình `Deepgram API key` cho ai-service ở biến môi trường hoặc secret của deployment.
2. Cấu hình endpoint và timeout cho việc gọi STT từ processing-service sang ai-service.
3. Chọn ngôn ngữ mặc định theo meeting hoặc theo user setting, ví dụ `vi` cho cuộc họp tiếng Việt.
4. Build lại ai-service để đảm bảo dependencies websocket và model config hoạt động đúng trong môi trường runtime.
5. Build processing-service sau khi thêm integration layer, rồi xác nhận WebSocket không bị blocking lâu khi audio chunk tới.

### Cách kiểm tra

#### Kiểm tra chức năng

1. Mở một meeting test và xác nhận nhận được `session.ready`.
2. Gửi audio chunk có giọng nói thực, không phải silence.
3. Xác nhận frontend nhận được `transcript.partial` với text có nghĩa, không còn placeholder `Audio received`.
4. Dừng nói và kiểm tra transcript final có được chốt đúng câu.

#### Kiểm tra kỹ thuật

1. Xem log processing-service để xác nhận binary audio được forward thay vì chỉ ACK.
2. Xem log ai-service để xác nhận adapter mở session và nhận transcript event.
3. Kiểm tra độ trễ từ lúc audio gửi lên đến lúc partial transcript xuất hiện.
4. Kiểm tra các trường hợp lỗi: thiếu API key, mất kết nối Deepgram, audio rỗng, session đóng sớm.

#### Kiểm tra build

1. Build processing-service và ai-service sau khi tích hợp.
2. Chạy test hoặc smoke test realtime WebSocket.
3. Xác nhận không phát sinh regression ở luồng broadcast hiện có của `RealtimeEventSubscriber`.

## 4. Kết luận

Luồng hiện tại đã hoàn chỉnh ở mức transport nhưng chưa có STT thực. Cách nhanh và thực tế nhất để có transcript thật là đi theo phương án C, tận dụng Deepgram streaming adapter đã có trong ai-service. Phương án này giữ được realtime, giảm thay đổi kiến trúc, và vẫn để ngỏ khả năng chuyển sang pipeline queue/worker ở giai đoạn sau nếu nhu cầu scale hoặc kiểm soát dữ liệu thay đổi.