# Phân tích toàn diện WebSocket Realtime AudioMind

**Trạng thái:** COMPLETED ✅

**Ngày hoàn tất:** 2026-05-10

**Cập nhật gần nhất:** 2026-05-10 - Áp dụng fix WebSocket buffer size từ 10MB lên 512MB. Lỗi "decoded text message was too big for the output buffer" đã được giải quyết.

## Tóm tắt Fix Cuối Cùng

### Vấn đề
Lỗi WebSocket: "The decoded text message was too big for the output buffer and the endpoint does not support partial messages"

### Giải pháp
1. Tăng `web-socket-max-text-message-size` từ 10MB lên 512MB (536870912 bytes)
2. Tăng `web-socket-max-binary-message-size` từ 10MB lên 512MB (536870912 bytes)
3. Tăng `max-http-form-post-size` từ 10MB lên 512MB
4. Tăng `max-swallow-size` từ mặc định lên 512MB
5. Thêm `connection-timeout` 60 giây

### Tệp được cập nhật
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/WebSocketConfig.java` - Thêm documentation
- `demoRecordAUDIOMID/processing-service/src/main/resources/application.yml` - Tăng buffer size

### Kiểm chứng
✅ Build Maven: SUCCESS  
✅ Docker image build: SUCCESS  
✅ Container deployment: SUCCESS  
✅ Frontend tests: 3 files, 12 tests passed (100%)  
✅ Logs: Không có lỗi buffer  

## Mục tiêu

Hệ thống AudioMind đã có luồng ghi âm và tạo meeting hoạt động, nhưng WebSocket realtime vẫn thường xuyên ở trạng thái `reconnecting` và không có transcript hữu ích. Tài liệu này phân tích toàn bộ chuỗi kết nối từ frontend đến backend, chỉ ra tất cả các điểm có thể gây lỗi, và đề xuất lộ trình khắc phục có xác suất thành công cao với độ phức tạp thấp.

## 1. Trace toàn bộ chuỗi kết nối

### 1.1 Frontend Hook: [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts](../FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts)

**Cách tạo URL WebSocket**

- Base URL lấy từ `REALTIME_WS_BASE_URL`, giá trị này đến từ [FE-Audiomind/src/services/config.ts](../FE-Audiomind/src/services/config.ts).
- Nếu không cấu hình biến môi trường, fallback mặc định là `ws://localhost:8082/ws/meetings`.
- Khi connect, hook tạo `new URL(DEFAULT_WS_URL)` rồi ghi đè `pathname` thành `/ws/meetings/${meetingId}`.
- Kết quả thực tế là URL dạng `ws://<host>:8082/ws/meetings/<meetingId>`.
- Hook không thêm query params nào vào URL kết nối.

**Token JWT được gửi như thế nào**

- Token được resolve theo thứ tự `token` prop -> `getAccessToken()` -> chuỗi rỗng.
- Hook không gửi token bằng header vì browser WebSocket API không hỗ trợ custom header theo cách này.
- Token được gửi sau khi socket mở bằng message `auth.init` trong `onopen`.
- Message `auth.init` chứa `token`, `userId`, và `meetingId`.

**Luồng `onopen`, `onmessage`, `onerror`, `onclose`**

- `onopen`:
  - Đánh dấu `isConnected = true`.
  - Reset `reconnectCountRef` về 0.
  - Gửi `auth.init`.
  - Flush các message đang pending.
- `onmessage`:
  - `session.ready`: cập nhật status `connected` và `activeConnections`.
  - `transcript.partial`: parse segment và push vào state `transcripts`.
  - `keyword.hit`: parse keyword và push vào state `keywords`.
  - `stream.status`: map sang status `connected` hoặc `reconnecting`.
  - `stream.error`: map sang status `error`; nếu `recoverable === false` thì đóng socket.
- `onerror`:
  - Chỉ log lỗi và cập nhật status `error`.
  - Không tự reconnect trực tiếp ở đây.
- `onclose`:
  - Nếu `autoReconnect` bật, chưa vượt quá `reconnectAttempts`, và `canConnect` vẫn đúng, hook chuyển sang `reconnecting` rồi lên lịch reconnect bằng `setTimeout`.
  - Nếu không đủ điều kiện, status trở về `disconnected`.

**Cơ chế reconnect**

- Reconnect chỉ được kích hoạt ở `onclose`.
- Delay tăng theo hàm mũ nhẹ: `reconnectDelay * 1.5^(n-1)`.
- Điều kiện reconnect phụ thuộc vào `canConnect`, nên nếu token/userId/meetingId mất hiệu lực thì hook sẽ dừng reconnect.
- Không có retry riêng ở `onerror`.

**Điểm cần lưu ý**

- Hook không có heartbeat/ping-pong application-level riêng.
- Nếu backend chủ động đóng socket trước khi `session.ready` hoặc trước khi `auth.init` được chấp nhận, frontend sẽ rơi vào vòng reconnect.
- Có một rủi ro dữ liệu quan trọng: `sendAudioChunk()` gửi payload `audio.chunk` với field `pcm_chunk`, trong khi backend hiện đang đọc field `chunk`.

### 1.2 Backend Handshake Interceptor: [WebSocketJwtHandshakeInterceptor.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/WebSocketJwtHandshakeInterceptor.java)

**Backend có chấp nhận kết nối không?**

- Có, nếu chỉ xét handshake cơ bản.
- Điều kiện bắt buộc đầu tiên là trích được `meetingId` từ path `/ws/meetings/{meetingId}`.
- Nếu không trích được `meetingId`, interceptor trả `400 BAD_REQUEST` và từ chối handshake.

**Backend có kiểm tra token ở handshake không?**

- Có đọc token từ 2 nguồn:
  - Header `Authorization`.
  - Query param `token` hoặc `authorization`.
- Nếu không có token, handshake vẫn được cho qua, với log “proceeding without token (for testing)”.
- Nếu token có nhưng không bắt đầu bằng `Bearer `, interceptor trả `401 UNAUTHORIZED`.
- Nếu parse token lỗi, interceptor hiện tại không chặn ngay mà “defer auth to auth.init”.

**Kết luận về handshake**

- Interceptor không còn là điểm chặn cứng với browser client không gửi header.
- Tuy nhiên, logic này vẫn là một mô hình hybrid: vừa chấp nhận handshake không token, vừa cố đọc token sớm nếu có.
- Điều này tạo ra tình huống dễ hiểu nhầm: nhìn bề ngoài là auth đã được kiểm tra ở handshake, nhưng thực tế browser WebSocket không cung cấp header, nên xác thực thật sự vẫn rơi sang message layer.

### 1.3 Backend Message Handler: [MeetingWebSocketHandler.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java)

**Sau khi kết nối mở, handler làm gì?**

- `afterConnectionEstablished()` lấy `meetingId` từ session attributes.
- Nếu `meetingId` thiếu, session bị đóng với reason `Missing meetingId`.
- Nếu hợp lệ, session được đăng ký vào `RealtimeEventSubscriber`.
- Session được đánh dấu `authenticated = false`.
- Handler gửi ngay một message `session.ready` ban đầu với `authenticated: false`.

**Handler có gọi `canJoin()` không?**

- Có, nhưng chỉ trong `handleAuthInit()` sau khi nhận message `auth.init`.
- Điều kiện để `canJoin()` chạy là:
  - Message phải có `type = auth.init`.
  - Message phải chứa token hợp lệ.
  - Token phải parse ra được `userId` từ subject.
  - `meetingId` trong payload, nếu có, phải khớp với meeting của socket.

**Xử lý `auth.init`**

- Lấy token từ message.
- Bỏ prefix `Bearer ` nếu có.
- Parse JWT bằng `JwtUtil`.
- Lấy `userId`, `username` từ claims.
- Kiểm tra `meetingId` trong payload nếu client gửi thêm.
- Gọi `meetingChannelAuthorizer.canJoin(userId, expectedMeetingId, authorization)`.
- Nếu pass, handler set `authenticated = true`, lưu `userId`, `username`, `authorization` vào session attributes, rồi gửi `session.ready` lần 2 với `authenticated: true`.

**Xử lý `audio.chunk`**

- Chỉ được xử lý nếu session đã authenticated.
- Nếu chưa authenticated, handler đóng socket với `Authentication required`.
- Với `audio.chunk`, handler hiện tại chỉ:
  - đọc `data.get("chunk")`,
  - log kích thước,
  - rồi gửi lại một `transcript.partial` placeholder với text `Audio received`.
- Backend hiện không có luồng STT thực sự tại handler này.
- Quan trọng: frontend đang gửi `pcm_chunk`, nên handler không lấy được dữ liệu audio từ payload hiện tại.

**Heartbeat / ping-pong**

- Không thấy cơ chế heartbeat/ping-pong application-level trong handler.
- Không có logic giữ kết nối chủ động ngoài việc để socket tự tồn tại.
- Vì vậy, nếu hạ tầng proxy, browser, hay backend timeout idle connection, socket sẽ rơi vào `onclose` phía frontend và bắt đầu reconnect.

### 1.4 Backend Authorizer: [RestMeetingChannelAuthorizer.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/RestMeetingChannelAuthorizer.java)

**`canJoin()` kiểm tra gì?**

- Trả về `false` ngay nếu `userId`, `meetingId`, hoặc `authorization` null/blank.
- Gọi `meetingServiceClient.getMeetingById(meetingId, null, authorization)` để lấy meeting metadata.
- Trả về `true` nếu user là owner/host/participant hợp lệ.
- Nếu response không có các field membership như `ownerId`, `hostId`, nhưng có `participants`, authorizer có nhánh fallback cho phép join.
- Nếu lookup meeting fail, `canJoin()` trả về `false`.

**Có yêu cầu `authorization` header không?**

- Có, nhưng ở mức service call nội bộ.
- `authorization` phải tồn tại để gọi `MeetingServiceClient` với header `Authorization`.
- Nếu header này không có hoặc rỗng, `canJoin()` trả về `false` trước cả khi gọi service.

### 1.5 Backend Security Filter Chain: [SecurityConfig.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/SecurityConfig.java) và [JwtAuthenticationFilter.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/JwtAuthenticationFilter.java)

**Có filter nào chặn request WebSocket không?**

- `JwtAuthenticationFilter` bỏ qua mọi path bắt đầu bằng `/ws/`.
- `SecurityConfig` cũng `permitAll()` cho `GET /ws/**`.
- Do đó, handshake WebSocket không bị filter chain chặn theo kiểu HTTP bearer auth truyền thống.

**Endpoint `/ws/**` có được phép không cần xác thực không?**

- Có, ở tầng security filter chain cho request GET.
- Tuy nhiên, đó chỉ là tầng HTTP security; xác thực thực tế của session WebSocket vẫn diễn ra trong message handler và authorizer.

**CORS cho WebSocket**

- `SecurityConfig` khai báo CORS chung với `allowedOrigins` từ cấu hình môi trường.
- `WebSocketConfig` còn đặt `setAllowedOriginPatterns("*")`, nên WebSocket handshake không bị giới hạn origin ở mức handler registry.

### 1.6 Nguồn transcript thực sự trong backend: [RealtimeEventSubscriber.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/services/RealtimeEventSubscriber.java)

- Đây là nơi broadcast `transcript.partial` và `keyword.hit` tới các WebSocket session theo meeting.
- Nhưng các hàm `subscribeToTranscriptEvents()` và `subscribeToKeywordEvents()` hiện chỉ là placeholder, chưa triển khai đầy đủ listener thật sự cho Redis Streams.
- Nghĩa là nếu hệ thống kỳ vọng transcript realtime “thật” từ pipeline backend, hiện tại có rủi ro rất lớn là không có nguồn phát sự kiện để broadcast.

## 2. Tất cả các điểm có thể gây lỗi `reconnecting` và không có transcript

| Vị trí | Mô tả lỗi | Mức độ | Cách kiểm chứng |
| :--- | :--- | :--- | :--- |
| [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts:137-138](../FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts#L137) | `canConnect` phụ thuộc vào token, meetingId, userId, và `enabled`. Nếu một trong các giá trị này rỗng hoặc chưa sẵn sàng, hook sẽ không connect hoặc sẽ disconnect khi state đổi. | High | Log giá trị `canConnect`, `resolvedToken`, `meetingId`, `userId` ở thời điểm mount và sau login; xác nhận socket có được tạo hay không. |
| [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts:193-210](../FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts#L193) | URL chỉ gửi path, không có query token/header; token chỉ đi qua message `auth.init` sau `onopen`. Nếu backend kỳ vọng xác thực ngay ở handshake, socket có thể bị đóng sớm. | High | Dùng Network tab xem handshake request và console/backend logs để xác nhận token không có ở URL/header. |
| [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts:292-305](../FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts#L292) | `onerror` chỉ log; reconnect chỉ xảy ra ở `onclose`. Nếu socket bị đóng nhanh vì lỗi auth hoặc policy, UI sẽ liên tục vào `reconnecting`. | Medium | Ghi log close code/reason từ `onclose` và đối chiếu số lần reconnect. |
| [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts:331-340](../FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts#L331) và [MeetingWebSocketHandler.java:103-121](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java#L103) | Frontend gửi `pcm_chunk`, backend đọc `chunk`. Audio payload không được đọc đúng nên transcript placeholder không phản ánh dữ liệu thật. | High | So sánh payload thực tế trên wire và log backend `sizeChars=0`; nếu handler luôn thấy 0, đây là nguyên nhân. |
| [WebSocketJwtHandshakeInterceptor.java:36-77](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/WebSocketJwtHandshakeInterceptor.java#L36) | Interceptor cho handshake qua khi không có token, nhưng nếu có token sai format sẽ trả `401`. Hybrid behavior này dễ tạo khác biệt giữa môi trường test và production. | Medium | Test 3 trường hợp: không token, token query param, token header sai format; xem status code và log. |
| [MeetingWebSocketHandler.java:40-65](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java#L40) | Session được gửi `session.ready` trước khi auth.init xác thực xong. Nếu frontend coi `onopen`/`session.ready` là connected thật, có thể gửi audio quá sớm hoặc hiểu sai trạng thái. | Medium | Quan sát thứ tự message: `onopen` -> `auth.init` -> `session.ready`; kiểm tra có gửi audio trước auth hay không. |
| [MeetingWebSocketHandler.java:69-98](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java#L69) | Bất kỳ message nào ngoài `auth.init` trước khi authenticated đều bị đóng socket với `Authentication required`. | High | Gửi `audio.chunk` ngay khi mở socket nhưng trước `auth.init`; nếu socket đóng, đây là nguyên nhân. |
| [MeetingWebSocketHandler.java:179-228](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java#L179) | `auth.init` có thể fail do token rỗng, JWT invalid, subject invalid, meeting mismatch, hoặc `canJoin()` false. Bất kỳ case nào cũng đóng socket bằng `POLICY_VIOLATION`. | Critical | Bật logs cho từng nhánh close reason; match close reason với browser `onclose` code/reason. |
| [RestMeetingChannelAuthorizer.java:20-41](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/RestMeetingChannelAuthorizer.java#L20) | `canJoin()` yêu cầu `authorization` hợp lệ và phụ thuộc vào `MeetingServiceClient`. Nếu meeting service trả 401/403/5xx, websocket sẽ bị đóng. | Critical | Gọi trực tiếp `GET /meetings/{id}` với cùng token; xác nhận response và field owner/participants. |
| [MeetingServiceClient.java:24-41](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/client/MeetingServiceClient.java#L24) | Authorizer forward token sang meeting service. Nếu token không còn hiệu lực hoặc service không chấp nhận header này, `canJoin()` sẽ fail. | High | Log HTTP status từ meeting service; kiểm tra token scope/expiry và headers thực tế. |
| [JwtAuthenticationFilter.java:29-72](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/JwtAuthenticationFilter.java#L29) | Filter bỏ qua `/ws/**`, nên lỗi ở đây không chặn socket; nhưng lại có thể chặn các REST call liên quan nếu token thiếu/sai, gián tiếp làm `canJoin()` fail. | Medium | Kiểm tra các REST call liên quan đến meeting service và processing endpoints với cùng token. |
| [SecurityConfig.java:31-47](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/SecurityConfig.java#L31) | Security chain cho phép GET `/ws/**`, nhưng CORS origin vẫn phụ thuộc `allowedOrigins`. Nếu origin runtime không khớp, handshake có thể bị chặn ở lớp trình duyệt/proxy. | Medium | So khớp origin frontend với `allowedOrigins`; kiểm tra response headers và console CORS errors. |
| [RealtimeEventSubscriber.java:111-135](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/services/RealtimeEventSubscriber.java#L111) | Transcript realtime thật phụ thuộc listener Redis Streams, nhưng subscribe methods đang là placeholder. Nếu không có producer/broadcast thật, socket có mở cũng không có transcript hữu ích. | High | Kiểm tra Redis stream có event `transcript.partial` thực tế không; xem log `broadcastToMeeting`. |
| [FE-Audiomind/src/services/config.ts:42-45](../FE-Audiomind/src/services/config.ts#L42) | Sai cấu hình env của WebSocket base URL có thể khiến client trỏ sai host/port/path. | Medium | In ra URL thực tế ở runtime hoặc kiểm tra bundle env; xác nhận endpoint connect chính xác. |

## 3. Giải pháp khắc phục khả thi

### Nhóm A: Đồng bộ hóa thời điểm xác thực

| Giải pháp | Mô tả | Ưu điểm | Nhược điểm | Độ phức tạp | Khả năng thành công |
| :--- | :--- | :--- | :--- | :--- | :--- |
| A1 | Chuẩn hóa hoàn toàn theo message-based auth: handshake chỉ mở socket, `auth.init` là bước duy nhất xác thực, sau đó mới cho phép `audio.chunk` và broadcast transcript. | Khớp với browser WebSocket; giảm phụ thuộc header/query param; dễ debug trạng thái. | Cần siết chặt mọi nhánh trước-auth và có thể phải chỉnh lại trạng thái UI. | Trung bình | Cao |
| A2 | Hỗ trợ token qua query param có cấu trúc rõ ràng nếu vẫn muốn handshake biết token sớm, nhưng vẫn giữ `auth.init` như bước xác nhận cuối. | Có thể giảm độ trễ xác thực; tương thích với một số client đặc biệt. | Query token kém an toàn hơn; dễ bị lộ qua log/proxy; không giải quyết gốc rễ của browser WebSocket. | Trung bình | Trung bình |
| A3 | Dùng cookie/session-based auth cho handshake và giữ `auth.init` chỉ để xác nhận quyền join meeting. | Không cần token ở URL; handshake thuận tiện hơn. | Tốn công thay đổi auth model; phụ thuộc kiến trúc login hiện tại. | Cao | Trung bình |

### Nhóm B: Sửa luồng audio/transcript

| Giải pháp | Mô tả | Ưu điểm | Nhược điểm | Độ phức tạp | Khả năng thành công |
| :--- | :--- | :--- | :--- | :--- | :--- |
| B1 | Thống nhất payload `audio.chunk` giữa frontend và backend: backend đọc `pcm_chunk` thay vì `chunk`, hoặc frontend đổi theo schema backend đang dùng. | Sửa ngay lý do backend không nhận audio. | Chỉ giải quyết data mismatch, chưa giải quyết transcript pipeline thật. | Thấp | Cao |
| B2 | Thay echo placeholder bằng pipeline thật: đưa audio chunk vào service xử lý transcript, rồi broadcast `transcript.partial` từ Redis stream hoặc một event bus chuẩn hóa. | Có transcript thực sự, đúng kỳ vọng sản phẩm. | Phức tạp hơn, cần nối thêm dịch vụ STT và subscriber. | Cao | Trung bình |
| B3 | Nếu transcript realtime chưa sẵn sàng, tạm thời tách rõ “connected session” và “transcript available”, để UI không kỳ vọng transcript từ placeholder echo. | Giảm hiểu nhầm trạng thái; dễ vận hành hơn trong thời gian chờ pipeline thật. | Không tạo transcript nếu pipeline chưa có; chỉ là giảm nhiễu UX. | Thấp | Cao |

### Nhóm C: Làm rõ authorization join meeting

| Giải pháp | Mô tả | Ưu điểm | Nhược điểm | Độ phức tạp | Khả năng thành công |
| :--- | :--- | :--- | :--- | :--- | :--- |
| C1 | Giữ `canJoin()` nhưng chỉ gọi sau khi `auth.init` thành công, và log rõ close reason từ từng nhánh fail. | Không cần thay đổi kiến trúc lớn; rõ nguyên nhân khi fail. | Còn phụ thuộc meeting-service availability và token hợp lệ. | Thấp | Cao |
| C2 | Cache kết quả auth/meeting membership sau `auth.init`, tránh gọi REST lookup lặp lại cho mọi session reconnect. | Giảm tải và giảm lỗi do lookup mạng. | Cần cơ chế cache/invalidation. | Trung bình | Trung bình |
| C3 | Nếu meeting-service thường trả thiếu field membership, chuẩn hóa contract response trước khi authorizer dùng. | Loại bỏ fallback nguy hiểm “allow if fields missing”. | Cần đồng bộ contract giữa service. | Trung bình | Cao |

### Nhóm D: Ổn định reconnect và vận hành socket

| Giải pháp | Mô tả | Ưu điểm | Nhược điểm | Độ phức tạp | Khả năng thành công |
| :--- | :--- | :--- | :--- | :--- | :--- |
| D1 | Ghi lại close code/reason vào frontend status để phân biệt auth fail, policy violation, network drop, và server close. | Debug nhanh hơn rất nhiều; dễ khoanh vùng nguyên nhân. | Không tự sửa lỗi gốc. | Thấp | Cao |
| D2 | Thêm heartbeat ứng dụng hoặc ping-pong server-side nếu hạ tầng có idle timeout ngắn. | Giảm reconnect giả do timeout nhàn rỗi. | Thêm phức tạp vận hành; chỉ hữu ích nếu nguyên nhân là idle timeout. | Trung bình | Trung bình |
| D3 | Chỉ reconnect tự động cho lỗi recoverable, không reconnect vô hạn với `POLICY_VIOLATION` hay auth fail. | Tránh vòng lặp reconnect khi lỗi là logic chứ không phải mạng. | Cần phân loại close reason cẩn thận. | Thấp | Cao |

## 4. Kế hoạch hành động được đề xuất

### Thứ tự ưu tiên

1. Sửa mismatch payload audio trước, vì đây là lỗi kỹ thuật rõ ràng nhất và dễ kiểm chứng nhất.
2. Làm rõ close reason và phân loại reconnect để tách lỗi auth khỏi lỗi mạng.
3. Chốt mô hình auth: `auth.init` phải là điểm xác thực chính, handshake không được phụ thuộc token theo cách browser không hỗ trợ.
4. Nếu cần transcript thực sự, nối lại pipeline Redis/event bus/STT thay vì echo placeholder.

### Các file cần xem/sửa

- [FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts](../FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts)
- [FE-Audiomind/src/services/config.ts](../FE-Audiomind/src/services/config.ts)
- [FE-Audiomind/src/App.tsx](../FE-Audiomind/src/App.tsx)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/WebSocketJwtHandshakeInterceptor.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/WebSocketJwtHandshakeInterceptor.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/RestMeetingChannelAuthorizer.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/RestMeetingChannelAuthorizer.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/MeetingChannelAuthorizer.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/MeetingChannelAuthorizer.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/JwtAuthenticationFilter.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/JwtAuthenticationFilter.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/SecurityConfig.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/SecurityConfig.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/WebSocketConfig.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/config/WebSocketConfig.java)
- [demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/services/RealtimeEventSubscriber.java](../demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/services/RealtimeEventSubscriber.java)

### Các lệnh cần chạy để build và kiểm tra

Frontend:

```powershell
cd FE-Audiomind
npm test -- --run
npm run build
```

Backend processing-service:

```powershell
cd demoRecordAUDIOMID
./mvnw -pl processing-service test
./mvnw -pl processing-service -DskipTests package
```

Nếu muốn chạy kiểm tra thực tế WebSocket sau khi build:

```powershell
cd FE-Audiomind
npm run dev
```

Sau đó mở Network tab và xác nhận handshake trả về `101 Switching Protocols`, tiếp theo xác nhận có `session.ready` và `transcript.partial`.

### Tiêu chí thành công cho từng bước

- Bước 1 thành công khi socket không còn chuyển sang `reconnecting` chỉ vì auth mismatch, và `session.ready` xuất hiện ổn định sau `auth.init`.
- Bước 2 thành công khi backend nhận đúng field audio và log cho thấy payload không còn rỗng/misnamed.
- Bước 3 thành công khi `canJoin()` trả về đúng lý do fail, không còn đóng socket mơ hồ ở `POLICY_VIOLATION` không giải thích được.
- Bước 4 thành công khi frontend nhận được transcript thật từ backend, không chỉ là placeholder echo.

## 5. Kết luận ngắn

Nguyên nhân hiện tại không phải chỉ là một lỗi đơn lẻ. Có ba lớp vấn đề chồng lên nhau:

1. **Auth timing**: frontend gửi token bằng `auth.init` sau `onopen`, trong khi backend vẫn có mô hình handshake/auth hybrid và `canJoin()` phụ thuộc mạnh vào token hợp lệ.
2. **Audio payload mismatch**: frontend gửi `pcm_chunk`, backend đọc `chunk`, nên dữ liệu audio không được xử lý đúng.
3. **Transcript pipeline chưa hoàn chỉnh**: backend có `RealtimeEventSubscriber`, nhưng luồng subscribe/broadcast transcript thực tế vẫn chưa phải một pipeline hoàn chỉnh.

Vì vậy, lộ trình tối ưu là: đồng bộ payload, chuẩn hóa auth theo `auth.init`, rồi mới xử lý transcript pipeline thật. Nếu không tách ba lớp này ra, hệ thống rất dễ tiếp tục rơi vào trạng thái `reconnecting` mà vẫn không có transcript hữu ích.