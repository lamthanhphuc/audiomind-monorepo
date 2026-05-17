# Kế hoạch sửa lỗi WebSocket authentication cho Ghi âm Trực tiếp

## Mục tiêu

WebSocket của AudioMind đang kết nối đúng endpoint và meeting ID đã là số nguyên, nhưng trạng thái vẫn là `disconnected` và transcript không hiển thị. Phân tích hiện tại cho thấy lỗi không nằm ở URL nữa, mà nằm ở cách token JWT được truyền và thời điểm backend kiểm tra token.

## 1. Phân tích nguyên nhân gốc rễ

### 1.1 Frontend hook: `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`

Luồng hiện tại trong hook cho thấy:

- `connect()` tạo WebSocket bằng `new WebSocket(wsUrl.toString())` với base URL lấy từ `REALTIME_WS_BASE_URL`.
- Token được lấy từ `token || getAccessToken()` và được yêu cầu phải có để `canConnect` trả về `true`.
- Khi `onopen` chạy, hook gửi ngay message `auth.init` chứa `token`, `userId`, `meetingId`.
- `onmessage` đã xử lý các message `session.ready`, `transcript.partial`, `keyword.hit`, `stream.status`, `stream.error`.
- `onerror` chỉ cập nhật trạng thái lỗi.
- `onclose` tự reconnect theo hàm mũ nếu `autoReconnect` bật.

Kết luận phía frontend:

- Frontend hiện không truyền token qua header, mà theo hướng message-based auth sau khi socket đã mở.
- Hook chỉ chuyển trạng thái thành `connected` sau `onopen`, nên nếu backend đóng socket ngay ở handshake hoặc ngay sau `afterConnectionEstablished()`, UI sẽ bị kéo về `disconnected` hoặc `reconnecting`.

### 1.2 Backend handshake interceptor: `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/WebSocketJwtHandshakeInterceptor.java`

Interceptor hiện tại đọc token theo thứ tự:

- `Authorization` header.
- Query string `token` hoặc `authorization`.

Nếu không có token, code vẫn ghi log là cho phép qua trong chế độ test, nhưng sau đó vẫn kiểm tra `Bearer ` và có thể trả `401 Unauthorized`. Khi parse JWT lỗi, interceptor có nhánh fallback đặt `userId = 1L`, `username = test_user`, rồi vẫn cho phép handshake qua nếu trích được `meetingId`.

Kết luận phía handshake:

- Interceptor vẫn đang mang tư duy “phải có token ngay lúc handshake”.
- Điều này không khớp với frontend, vì browser WebSocket API không gửi được custom `Authorization` header theo cách HTTP client thông thường.
- Query param là fallback, nhưng hiện không phải hướng chính và đã từng gây sai lệch URL.

### 1.3 Backend message handler: `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java`

Handler hiện tại có ba điểm quan trọng:

- `afterConnectionEstablished()` lấy `userId`, `meetingId`, `authorization` từ session attributes.
- Trước khi register session, handler gọi `meetingChannelAuthorizer.canJoin(userId, meetingId, authorization)`.
- `handleTextMessage()` hiện chỉ đọc payload rồi trả về `stream.status` dạng `received`.

Điều này có nghĩa:

- Backend hiện chưa thực sự xử lý message `auth.init`.
- Token do frontend gửi sau `onopen` không được dùng để xác thực quyền join.
- Nếu `authorization` không có trong session attribute, `canJoin()` sẽ fail ngay.

### 1.4 Authorizer: `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/RestMeetingChannelAuthorizer.java`

`canJoin()` trả về `false` ngay nếu một trong các điều kiện sau sai:

- `userId == null`
- `meetingId == null`
- `authorization == null`
- `authorization.isBlank()`

Sau đó nó gọi `meetingServiceClient.getMeetingById(meetingId, null, authorization)` để xác thực quyền dựa trên dữ liệu meeting.

Kết luận:

- Đây là điểm chặn mạnh nhất hiện tại.
- Nếu WebSocket handshake thành công nhưng `authorization` chưa có trong session, handler vẫn sẽ đóng kết nối ở `afterConnectionEstablished()`.
- Vì frontend chỉ gửi token bằng `auth.init` sau khi socket mở, token đến quá muộn so với chỗ backend đang kiểm tra.

### 1.5 Cấu hình realtime: `FE-Audiomind/src/services/config.ts` và compose

Giá trị hiện tại của WebSocket base URL là:

- `FE-Audiomind/src/services/config.ts` dùng fallback mặc định `ws://localhost:8082/ws/meetings`.
- `infra/docker-compose.dev.yml` đang inject trực tiếp `VITE_REALTIME_WS_BASE_URL: ws://localhost:8082/ws/meetings`.
- Compose cũng bật `VITE_REALTIME_WS_ENABLED: "true"`.

Kết luận:

- Giá trị base URL hiện tại là đúng.
- Vấn đề không còn nằm ở host/port/path của WebSocket.

## 2. Giải pháp đề xuất theo mức ưu tiên

| Giải pháp | Mô tả | Khả năng thành công |
| :--- | :--- | :---: |
| A | Chuyển xác thực sang message-based hoàn toàn: handshake chỉ mở socket, backend nhận `auth.init` trong `handleTextMessage()`, validate token rồi mới đánh dấu session đã xác thực và cho phép stream/transcript. | Cao |
| B | Nếu vẫn muốn giữ handshake auth, frontend phải truyền token theo cách backend đọc được ngay lúc upgrade; tuy nhiên browser WebSocket không hỗ trợ custom header, nên hướng này chỉ khả thi nếu đổi giao thức hoặc dùng cookie/session. | Trung bình |
| C | Bổ sung xử lý bắt buộc cho `auth.init` trong `MeetingWebSocketHandler`, nhưng vẫn giữ `canJoin()` ở `afterConnectionEstablished()` sẽ chưa đủ; cần di chuyển kiểm tra quyền join sang sau khi xác thực message. | Thấp |
| D | Kiểm tra network/CORS/firewall/101 Switching Protocols nếu socket không mở được ở tầng transport. Hướng này ít khả năng là nguyên nhân chính vì URL và meeting ID đã đúng, nhưng vẫn nên xác minh khi đã sửa logic auth. | Thấp |

## 3. Kế hoạch hành động chi tiết

### Bước 1: Chốt lại mô hình auth đúng với browser WebSocket

File cần xem/sửa:

- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/MeetingWebSocketHandler.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/security/RestMeetingChannelAuthorizer.java`
- `demoRecordAUDIOMID/processing-service/src/main/java/com/example/processingservice/interfaces/websocket/WebSocketJwtHandshakeInterceptor.java`

Hướng sửa:

- Cho handshake chỉ làm nhiệm vụ mở socket và gắn `meetingId`.
- Không chặn theo JWT ở handshake nếu token chưa có.
- Di chuyển logic xác thực token sang message đầu tiên `auth.init`.
- Sau khi token hợp lệ, mới gọi authorizer hoặc mới register session.

### Bước 2: Sửa backend để thật sự hiểu `auth.init`

File cần sửa:

- `MeetingWebSocketHandler.java`

Điểm cần thay đổi trong logic:

- Trong `handleTextMessage()`, parse payload JSON và đọc `type`.
- Nếu `type == "auth.init"`, lấy `token`, `userId`, `meetingId` từ message.
- Validate JWT bằng `JwtUtil` hoặc cơ chế hiện có.
- Ghi `userId`, `username`, `authorization` vào `session.getAttributes()`.
- Chỉ sau đó mới gửi `session.ready` và cho phép `audio.chunk`/`stream.pause`/`stream.resume`.
- Nếu token sai, đóng socket bằng `CloseStatus.POLICY_VIOLATION` hoặc mã tương đương.

### Bước 3: Điều chỉnh chỗ kiểm tra quyền join

File cần sửa:

- `RestMeetingChannelAuthorizer.java`

Điểm cần thay đổi:

- Không ép `authorization` phải có trước khi auth message được xử lý xong.
- Nếu backend muốn giữ lớp authorizer REST, thì token sau khi validate cần được lưu lại và truyền vào authorizer.
- Nếu chưa có token hợp lệ, không gọi `canJoin()` ở `afterConnectionEstablished()`.

### Bước 4: Giữ frontend theo mô hình hiện tại nhưng kiểm tra trạng thái rõ ràng hơn

File cần kiểm tra:

- `FE-Audiomind/src/hooks/useRealtimeMeetingStream.ts`

Điểm cần xác minh:

- `auth.init` phải được gửi ngay sau `onopen`.
- `onmessage` phải chấp nhận `session.ready` như tín hiệu xác thực thành công.
- `onclose` chỉ reconnect khi chưa nhận được `session.ready` hoặc khi backend chủ động đóng vì lỗi recoverable.
- Khi nhận `stream.error`, cần phân biệt lỗi auth với lỗi stream để UI không quay vòng reconnect vô hạn.

### Bước 5: Rebuild Docker image

Lệnh rebuild đề xuất:

```powershell
docker compose -f infra/docker-compose.dev.yml build --no-cache web processing-api
docker compose -f infra/docker-compose.dev.yml up -d web processing-api
```

Nếu cần kiểm tra riêng backend trước:

```powershell
docker compose -f infra/docker-compose.dev.yml build --no-cache processing-api
docker compose -f infra/docker-compose.dev.yml up -d processing-api
```

### Bước 6: Kiểm tra kết quả

Kiểm tra chức năng:

- Hard refresh browser để chắc chắn bundle mới được tải.
- Login bằng tài khoản test.
- Mở tab `Ghi âm Trực tiếp`.
- Bấm bắt đầu ghi âm.
- Xác nhận WebSocket chuyển từ `disconnected` sang `connected`.
- Xác nhận transcript hiển thị `session.ready` và ít nhất một `transcript.partial`.

Kiểm tra kỹ thuật:

- Network tab phải thấy WebSocket trả `101 Switching Protocols`.
- Console không còn URL chứa query token nếu đã bỏ hướng query-param.
- Backend logs phải có log handshake và log xử lý `auth.init`.

### Bước 7: Validate frontend trước khi chốt

Lệnh nên chạy trong `FE-Audiomind`:

```powershell
npm test -- --run
npm run build
```

Kỳ vọng:

- Test pass.
- Build tạo bundle mới không lỗi TypeScript/Vite.

## 4. Kết luận ngắn

Nguyên nhân có khả năng cao nhất không phải là URL hay port nữa, mà là mismatch về thời điểm xác thực:

- Frontend gửi token sau khi socket đã mở bằng `auth.init`.
- Backend lại kiểm tra `authorization` ngay trong handshake / `afterConnectionEstablished()`.

Vì vậy, hướng sửa ưu tiên là chuyển sang message-based auth thực thụ: handshake mở socket, `auth.init` xác thực session, rồi mới cho phép stream/transcript.