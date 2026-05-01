# Hướng dẫn Thủ công: Các bước Tiếp theo cho Dự án AudioMind

Tài liệu này hướng dẫn bạn thực hiện các bước thủ công để kiểm thử và kích hoạt hệ thống realtime trên môi trường staging và production.

## 1. Kiểm tra Môi trường Staging

**Mục tiêu:** Xác nhận hệ thống hoạt động ổn định trên môi trường staging.

1.  **Truy cập Staging:**
    *   Mở trình duyệt và truy cập URL staging của bạn (ví dụ: `https://staging.audiomind.example.com`).
    *   Đăng nhập bằng tài khoản test:
        *   Username: `e2e_test_user`
        *   Password: `Ph@050204`

2.  **Kiểm tra health của các service:**
    *   Mở terminal, chạy các lệnh `curl` sau để kiểm tra health check endpoints:

    ```bash
    curl https://staging.audiomind.example.com/actuator/health
    curl https://staging.audiomind.example.com/api/health
    ```

    Kết quả mong đợi: Tất cả đều trả về `{"status":"UP"}` hoặc healthy.

3.  **Kiểm tra luồng batch/polling cũ:**
    1. Tạo một meeting mới trên giao diện staging.
    2. Upload một file audio nhỏ (.wav, .mp3) vào meeting đó.
    3. Xác nhận trạng thái job chuyển từ `QUEUED` -> `PROCESSING` -> `COMPLETED`.
    4. Sau khi `COMPLETED`, kiểm tra transcript và analysis có được trả về đầy đủ không.

## 2. Kiểm tra Luồng Realtime

**Mục tiêu:** Xác nhận tính năng realtime mới (WebSocket, keyword highlight) hoạt động theo thời gian thực.

1.  **Bật Feature Flag:**
    *   Mở file `.env.staging` trong dự án (hoặc nơi config env của frontend staging).
    *   Đảm bảo dòng `VITE_REALTIME_WS_ENABLED=true` có trong file.
    *   Nếu chưa có, thêm vào và deploy lại frontend (hoặc build & deploy theo quy trình hiện tại).

2.  **Kiểm tra bằng Script:**
    *   Sử dụng script `scripts/ws_listener.py` có sẵn trong repo để kết nối tới WebSocket Gateway.
    *   Mở terminal, chạy lệnh sau (thay `<meeting_id>` và `<token>` bằng giá trị thực tế):

    ```powershell
    python scripts/ws_listener.py <meeting_id> <token> wss://staging.audiomind.example.com
    ```

    *   Trong khi script đang chạy, thực hiện upload audio và start processing trên giao diện web.
    *   Theo dõi output của script. Bạn sẽ thấy các sự kiện:
        - `session.ready`
        - `transcript.partial`
        - `keyword.hit`

    Kết quả mong đợi: Nhận được ít nhất 1 `transcript.partial` và 1 `keyword.hit`.

3.  **Kiểm tra UI:**
    *   Trên giao diện web, mở meeting đang test.
    *   Xác nhận transcript cập nhật realtime (partial hoặc incremental) và từ khóa được highlight tương ứng với thời điểm nói.

## 3. Kế hoạch Canary cho Production

**Mục tiêu:** Triển khai tính năng realtime lên production một cách an toàn.

### Giai đoạn 1: 5% Người dùng (3 ngày)

- Bật feature flag cho 5% người dùng ngẫu nhiên.
- Theo dõi các metric quan trọng trong 3 ngày:
  - `ws_connected`: Số lượng kết nối WebSocket đang hoạt động.
  - `event_lag_ms`: Độ trễ từ khi nói đến khi highlight (mục tiêu: p95 ≤ 1500ms).
  - `keyword_hit_rate`: Tỉ lệ phát hiện từ khóa thành công.
  - `event_loss`: Tỉ lệ mất sự kiện (mục tiêu: < 0.1%).
  - `error_rate`: Tỉ lệ lỗi của API và WebSocket.

### Giai đoạn 2: 25% Người dùng (2 ngày)

- Nếu các chỉ số ở giai đoạn 1 ổn định, mở rộng lên 25%.
- Tiếp tục theo dõi các metric trong 2 ngày.

### Giai đoạn 3: 100% Người dùng

- Nếu tất cả các chỉ số vẫn trong ngưỡng an toàn, bật feature flag cho toàn bộ người dùng.

### Kế hoạch Rollback

- Nếu bất kỳ metric nào vượt ngưỡng nguy hiểm (ví dụ: `event_loss > 1%`, `error_rate` tăng đột biến), tắt ngay feature flag (`VITE_REALTIME_WS_ENABLED=false`).
- Hệ thống sẽ tự động quay về luồng batch/polling cũ. Không cần deploy lại code.

## 4. Tích hợp Deepgram (Bước Tiếp theo)

**Mục tiêu:** Thay thế mock/fallback trong `STTAdapter` bằng kết nối thật tới Deepgram API để có chất lượng nhận dạng giọng nói tốt nhất.

1.  **Chuẩn bị:**
    - Lấy `DEEPGRAM_API_KEY` từ vault hoặc biến môi trường bảo mật.
    - Đảm bảo backend có thể sử dụng WebSocket/HTTP kết nối tới Deepgram.

2.  **Hướng dẫn cho lập trình viên (prompt cho AI / dev):**

    ```text
    Trong ai-service, hãy hoàn thiện DeepgramSTTAdapter trong file app/services/stt_adapter.py. Hiện tại nó đang là mock. Hãy triển khai kết nối thật tới Deepgram API bằng biến môi trường DEEPGRAM_API_KEY. Đảm bảo gửi audio chunk qua WebSocket và nhận transcript partial. Sau khi code xong, chạy pytest để đảm bảo không có regression. Cập nhật trạng thái vào codebase_review.md.
    ```

3.  **Kiểm thử sau khi triển khai adapter:**
    - Chạy unit tests: `pytest demoRecordAUDIOMID/ai-service/tests -q`.
    - Thực hiện một test E2E staging: upload audio ngắn, kiểm tra nhận transcript realtime và compare với mock cũ.

## 5. Kiểm tra sau cùng và commit

1.  **Kiểm tra workspace git:**

    ```powershell
    git checkout main
    git pull origin main
    git status
    ```

    - Nếu còn file chưa commit: thêm và commit với message: `chore: final post-merge cleanup`.
      ```powershell
      git add .
      git commit -m "chore: final post-merge cleanup"
      git push origin main
      ```

2.  **Tạo và đẩy tag (nếu cần):**

    ```powershell
    git tag v1.0.0-rapid-remediation-complete -m "Hoàn tất sửa 40 issue và tích hợp realtime"
    git push origin v1.0.0-rapid-remediation-complete
    ```

## 6. Ghi chú vận hành và liên hệ

- Nếu phát hiện sự cố nghiêm trọng trong giai đoạn Canary, liên hệ on-call backend và SRE.
- Lưu logs liên quan vào `logs/` theo ngày để phục vụ điều tra.

---

## Bắt đầu thực hiện

- Tôi đã thực hiện các bước dọn dẹp Git cơ bản và đẩy tag (xem commit history và tag trên remote).
- Thực hiện tuần tự: Nhiệm vụ 1 (git cleanup & tagging), sau đó Nhiệm vụ 2 (tạo file hướng dẫn này).

Chúc bạn triển khai an toàn — cho tôi biết nếu muốn tôi mở Pull Request, cập nhật `codebase_review.md`, hoặc chạy các script kiểm thử tự động.
