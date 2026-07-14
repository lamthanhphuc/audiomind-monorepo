# AudioMind Realtime Transcript Failure - Analysis & Plan

## 2.1. Phân tích Vấn đề (Root Cause Analysis)

### Mô tả logic của lỗi
Luồng hiện tại đang dùng một điều kiện trạng thái nội bộ là `AUDIO_SENT_ATTR` để quyết định có được gọi `finalizeSttSession()` hay không. Tuy nhiên, cờ này chỉ phản ánh việc backend đã gửi audio chunk thành công đến `ai-service`, không phản ánh việc hệ thống đã **nhận đủ dữ liệu**, **đã đến thời điểm kết thúc stream**, hay **cần phải finalize để lấy transcript cuối cùng**.

Điểm yếu thiết kế nằm ở chỗ: một quyết định nghiệp vụ quan trọng là finalize transcript lại bị phụ thuộc vào một cờ mang tính kỹ thuật và có thể đến muộn. Khi websocket đóng hoặc timeout xảy ra trước thời điểm cờ này được set, luồng finalize bị bỏ qua hoàn toàn. Điều đó tạo ra một khoảng hở giữa “đã nhận audio” và “đã xác nhận xong việc gửi audio”, và chính khoảng hở này làm transcript cuối không bao giờ được yêu cầu từ `ai-service`.

### Có phải race condition không?
Có. Đây là một race condition ở mức điều phối trạng thái giữa các sự kiện bất đồng bộ:
- luồng nhận audio chunk;
- luồng gọi `ai-service`;
- luồng đóng websocket / finalize khi session kết thúc.

Nếu session kết thúc trước khi `AUDIO_SENT_ATTR` được set, finalize bị bỏ qua dù audio thực tế đã có mặt trong pipeline.

### Ít nhất 3 tình huống có thể khiến transcript không được gửi đi
1. WebSocket đóng trước khi request cuối tới `ai-service` hoàn tất, khiến `AUDIO_SENT_ATTR` chưa được bật nhưng finalize đã bị bỏ qua.
2. Request tới `ai-service` bị chậm hoặc timeout, làm `finalizeSttSession()` không được kích hoạt đúng thời điểm hoặc không có cơ hội gửi `is_final=true`.
3. Audio chunk đầu vào có được nhận ở websocket nhưng xử lý downstream không hoàn tất, dẫn tới chỉ có partial transcript rỗng hoặc không có transcript cuối.
4. Session bị đóng sớm do logic timeout / idle / network interruption, nhưng hệ thống không có hàng đợi finalize bền vững để đảm bảo thao tác chốt transcript vẫn được thực hiện sau đó.
5. Backend chỉ dựa vào trạng thái “đã gửi thành công” thay vì “đã nhận audio cần finalize”, nên bất kỳ lỗi transient nào trong bước gửi AI đều biến finalize thành một thao tác có điều kiện quá chặt.

## 2.2. Đề xuất Giải pháp

### Phương án A: Sửa cờ `AUDIO_SENT_ATTR` (Tối thiểu)
**Ý tưởng chính**
Tách điều kiện finalize ra khỏi trạng thái “gửi thành công tới AI service”, và thay bằng một cờ phản ánh “đã nhận audio cần finalize”.

**Cách thức hoạt động**
- Set cờ trạng thái ngay khi backend nhận được audio chunk hợp lệ.
- `finalizeSttSession()` chỉ cần kiểm tra xem session có từng nhận audio hay không.
- Nếu có audio đã nhận, luôn cố gắng gửi request cuối `is_final=true`.

**Ưu điểm**
- Sửa nhanh, ít thay đổi.
- Giảm ngay nguy cơ bỏ lỡ finalize do timeout hoặc đóng sớm.
- Phù hợp nếu cần khắc phục khẩn cấp.

**Nhược điểm**
- Vẫn phụ thuộc vào session state cục bộ trong một websocket connection.
- Chưa giải quyết triệt để các trường hợp retry, finalize muộn, hoặc phục hồi sau lỗi.
- Có thể vẫn tồn tại các cạnh tranh trạng thái nếu session đóng bất thường.

**Độ phức tạp khi triển khai**
Thấp.

### Phương án B: Thêm cơ chế “Deadline” cho việc finalize (Trung bình)
**Ý tưởng chính**
Đưa finalize thành một tác vụ có deadline rõ ràng, tách khỏi vòng đời websocket thuần túy.

**Cách thức hoạt động**
- Khi nhận audio chunk đầu tiên, tạo trạng thái session có deadline finalize.
- Khi websocket đóng, nếu chưa finalize thì enqueue một lần finalize hậu kiểm.
- Deadline bảo đảm sau một khoảng thời gian hoặc khi kết thúc stream, hệ thống sẽ cố gửi `is_final=true` dù websocket đã đóng.
- Có thể dùng job trạng thái nội bộ hoặc hàng đợi nhẹ để retry một vài lần.

**Ưu điểm**
- Bền vững hơn phương án A.
- Giảm rủi ro do mạng chập chờn, socket đóng sớm, hoặc request AI chậm.
- Có thể theo dõi và đo lường trạng thái finalize rõ hơn.

**Nhược điểm**
- Phức tạp hơn về trạng thái và lifecycle.
- Cần quản lý retry, expiry, cleanup để tránh leak session/job.
- Vẫn là giải pháp mang tính điều phối, chưa thay đổi kiến trúc xử lý transcript ở mức sâu.

**Độ phức tạp khi triển khai**
Trung bình.

### Phương án C: Thiết kế lại hoàn toàn luồng xử lý (Triệt để)
**Ý tưởng chính**
Tách hoàn toàn việc nhận audio khỏi việc tạo transcript cuối bằng một pipeline có trạng thái bền vững và idempotent, trong đó finalize transcript là một bước bắt buộc của vòng đời session chứ không phụ thuộc vào trạng thái websocket tức thời.

**Cách thức hoạt động**
- WebSocket chỉ chịu trách nhiệm ingest audio và ghi nhận sự kiện stream.
- Một state machine hoặc job store riêng quản lý vòng đời transcript: `open -> receiving -> closing -> finalized -> delivered`.
- Khi stream kết thúc, một finalization task được tạo ra độc lập với websocket session.
- `ai-service` được gọi với `is_final=true` bằng cơ chế retry/idempotent.
- Kết quả final transcript được lưu bền vững và chỉ broadcast khi đã có trạng thái hợp lệ.
- Nếu websocket đã đóng, frontend vẫn có thể nhận transcript qua cơ chế fallback/polling hoặc reconnect-based sync.

**Ưu điểm**
- Giải quyết triệt để race condition và các biến thể của lỗi finalize.
- Chống tốt hơn với timeout, disconnect, reconnect, và xử lý chậm.
- Mô hình rõ ràng, dễ mở rộng cho retry, observability, và phục hồi sau lỗi.

**Nhược điểm**
- Thay đổi kiến trúc lớn hơn.
- Nhiều file và nhiều luồng phải đồng bộ lại.
- Cần có kế hoạch kiểm thử chặt chẽ để tránh regressions.

**Độ phức tạp khi triển khai**
Cao.

## 2.3. Khuyến nghị và Lộ trình

### Khuyến nghị
Phương án tối ưu nhất để triển khai ngay bây giờ là **Phương án B: Thêm cơ chế “Deadline” cho việc finalize**.

### Lý do chọn phương án B
- Phương án A sửa nhanh nhưng vẫn bám vào một cờ trạng thái dễ bị lệch khi hệ thống chậm hoặc đóng sớm.
- Phương án C là hướng đúng về dài hạn, nhưng chi phí thay đổi và rủi ro triển khai cao hơn mức cần thiết cho một lỗi đang gây ảnh hưởng trực tiếp.
- Phương án B cân bằng tốt nhất giữa độ an toàn, khả năng khắc phục race condition, và phạm vi thay đổi.
- Nó cho phép hệ thống luôn có một cơ chế finalize độc lập với lifecycle websocket, nhưng không bắt buộc phải làm lại toàn bộ pipeline ngay lập tức.

### Lộ trình thực hiện ngắn gọn
1. Rà soát và chuẩn hóa điều kiện finalize trong `processing-service` để không phụ thuộc hoàn toàn vào trạng thái “đã gửi thành công” của audio chunk.
2. Tách trạng thái “đã nhận audio” khỏi trạng thái “đã xong gửi AI service” và dùng nó làm điều kiện chính cho finalize.
3. Bổ sung cơ chế deadline / retry cho finalize để đảm bảo yêu cầu `is_final=true` vẫn được gửi ngay cả khi websocket đóng sớm hoặc request trước đó timeout.
4. Kiểm tra lại logic broadcast transcript cuối để bảo đảm transcript final được cache và có đường fallback khi session đã đóng.
5. Xác minh tương thích ở `ai-service` để bảo đảm final request có thể trả transcript cuối hoặc raw response hợp lệ.

### Các file cần sửa
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java](demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/AIServiceClient.java)
- [demoRecordAUDIOMID/ai-service/app/main.py](demoRecordAUDIOMID/ai-service/app/main.py)
- [demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py](demoRecordAUDIOMID/ai-service/app/services/stt_adapter.py)
- [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts](FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts)
- [FE-Audiomind/src/components/RealtimeTranscript.tsx](FE-Audiomind/src/components/RealtimeTranscript.tsx)

### Logic cần thay đổi
- Điều chỉnh finalize để luôn có đường đi khi stream đã từng nhận audio.
- Bổ sung finalize deadline/retry độc lập với websocket lifecycle.
- Bảo đảm transcript cuối được cache và broadcast/fallback nhất quán.
- Giữ frontend ở trạng thái nhận transcript partial/final mà không phụ thuộc vào một event duy nhất từ websocket session đang mở.
