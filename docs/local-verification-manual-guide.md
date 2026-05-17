# Hướng dẫn Kiểm tra Thủ công trên Local

Tài liệu này hướng dẫn bạn thực hiện các bước kiểm tra thủ công trên môi trường local sau khi hệ thống đã được khởi động.

**Trạng thái hệ thống hiện tại:**
- ✅ **Giai đoạn 1 (Tự động)** đã hoàn tất
  - Docker Compose stack đã khởi động
  - Services: user-api (8083), processing-api (8082), postgres (5432), redis (6379), diarization-service (8012) đều UP
  - Frontend (web) chạy trên port 8080
  - ⚠️ Lưu ý: AI service (ai-api, celery-worker) còn cần debug (entrypoint issue)
- 🔄 **Giai đoạn 2** để bạn thực hiện các bước thủ công dưới đây

---

## 1. Truy cập Frontend Local

**Cách truy cập chính:** mở frontend tại **http://localhost:8080**.

1. Mở trình duyệt (Chrome, Edge, hoặc Firefox).
2. Nhập địa chỉ: **http://localhost:8080**.
3. Bạn sẽ thấy giao diện đăng nhập của AudioMind.
4. Đăng nhập với tài khoản test:
   - **Username:** `e2e_test_user`
   - **Password:** `Test@123456`
5. Sau khi đăng nhập, bạn sẽ thấy dashboard chính.

**Kết quả mong đợi:** Đăng nhập thành công, hiển thị dashboard với các menu và khu vực chức năng.

**Nếu lỗi:** 
- Kiểm tra xem Docker Compose đã chạy chưa bằng lệnh:
  ```powershell
  cd D:\Bin\EXE101\Thu_muc_moi
  docker compose -f infra/docker-compose.dev.yml ps
  ```
- Nếu user-api không chạy, kiểm tra logs:
  ```powershell
  docker logs infra-user-api-1 --tail 50
  ```

---

## 2. Kiểm tra UI Realtime

### 2.1. Bật Feature Flag Realtime

1. Mở file `FE-Audiomind\.env` (nếu chưa có, tạo mới từ `.env.example`).
2. Thêm hoặc sửa dòng sau:
   ```
   VITE_REALTIME_WS_ENABLED=true
   ```
3. Lưu file.
4. Khởi động lại frontend (nếu chạy độc lập):
   ```powershell
   cd D:\Bin\EXE101\Thu_muc_moi\FE-Audiomind
   npm run dev
   ```
   Hoặc nếu chạy qua Docker, khởi động lại container:
   ```powershell
   docker compose -f D:\Bin\EXE101\Thu_muc_moi\infra\docker-compose.dev.yml restart web
   ```

### 2.2. Tạo cuộc họp và Upload Audio

1. Trên giao diện web, tìm nút **"New Meeting"** hoặc **"Tạo cuộc họp mới"**.
2. Nhập tiêu đề cuộc họp (ví dụ: **"Test Realtime"**).
3. Tìm nút **"Upload Audio"** và chọn một file audio (.wav hoặc .mp3).
4. **Nếu chưa có file audio test**, tạo bằng lệnh:
   ```powershell
   cd D:\Bin\EXE101\Thu_muc_moi
   python scripts/generate_test_wav.py
   ```
   File sẽ được tạo và bạn có thể sử dụng để upload.
5. Sau khi upload, nhấn **"Start Processing"** để bắt đầu xử lý.

### 2.3. Quan sát Kết quả Realtime

Khi job đang chạy (trạng thái PROCESSING hoặc PARTIAL), bạn sẽ thấy:

- **Transcript xuất hiện từng phần** (partial) ở khu vực chính giữa màn hình
- **Các từ khóa chuyên ngành** được highlight (bôi sáng) trong transcript
- **Thanh sidebar bên phải** hiển thị danh sách từ khóa kèm tooltip định nghĩa
- Khi job hoàn tất (trạng thái COMPLETED), **transcript đầy đủ** và **analysis** sẽ hiển thị

**Kết quả mong đợi:**
- ✅ Transcript cập nhật theo thời gian thực khi audio đang xử lý
- ✅ Từ khóa chuyên ngành được highlight trong transcript
- ✅ Sidebar hiển thị danh sách từ khóa
- ✅ Job đạt trạng thái COMPLETED sau khi xử lý hoàn tất

**Nếu không thấy realtime:**
- Kiểm tra console browser (F12 → Console) để xem có lỗi WebSocket không
- Kiểm tra đảm bảo `VITE_REALTIME_WS_ENABLED=true` trong file `.env` của frontend
- Khởi động lại dev server hoặc Docker container web

---

## 3. Xác nhận Polling Fallback

### 3.1. Tắt Feature Flag Realtime

1. Mở file `FE-Audiomind\.env`.
2. Sửa dòng:
   ```
   VITE_REALTIME_WS_ENABLED=false
   ```
3. Lưu file.
4. Khởi động lại frontend:
   ```powershell
   cd D:\Bin\EXE101\Thu_muc_moi\FE-Audiomind
   npm run dev
   ```
   Hoặc nếu chạy Docker:
   ```powershell
   docker compose -f D:\Bin\EXE101\Thu_muc_moi\infra\docker-compose.dev.yml restart web
   ```

### 3.2. Chạy lại quy trình

1. Tạo một cuộc họp mới.
2. Upload file audio.
3. Nhấn **"Start Processing"**.

### 3.3. Quan sát Polling

Khi realtime bị tắt, giao diện sẽ quay về luồng batch/polling cũ:

- Trạng thái job hiển thị là: **QUEUED → PROCESSING → COMPLETED**
- **Transcript và analysis** chỉ hiển thị sau khi job hoàn tất
- **Không có cập nhật realtime** trong quá trình xử lý
- Frontend sẽ poll backend theo khoảng thời gian định sẵn

**Kết quả mong đợi:**
- ✅ Job vẫn chạy thành công đến trạng thái COMPLETED
- ✅ Transcript và analysis hiển thị đầy đủ sau khi job hoàn tất
- ✅ Không có lỗi hoặc crash
- ✅ UI quay về polling mode (không realtime updates)

---

## 4. Xử lý Sự cố Thường gặp

| Vấn đề | Cách khắc phục |
|--------|----------------|
| Không truy cập được `http://localhost:8080` | Kiểm tra Docker Compose: `docker compose -f infra/docker-compose.dev.yml ps`. Khởi động lại nếu cần: `docker compose -f infra/docker-compose.dev.yml up -d` |
| Đăng nhập thất bại | Kiểm tra user-api đã chạy chưa: `curl http://localhost:8083/actuator/health`. Nếu chưa có tài khoản, chạy: `.\scripts\setup-e2e-account.ps1` |
| Upload audio bị lỗi | Đảm bảo file audio đúng định dạng (.wav, .mp3). Kiểm tra dung lượng file không quá lớn (~10-30MB tối đa). Nếu upload qua web thất bại, kiểm tra processing-api: `curl http://localhost:8082/actuator/health` |
| Job bị kẹt ở trạng thái QUEUED | Kiểm tra celery-worker và ai-service đã chạy: `docker compose logs celery-worker --tail 50`. Nếu không chạy, setup lại: `docker compose -f infra/docker-compose.dev.yml restart celery-worker` |
| Transcript không hiển thị | Kiểm tra processing-service: `curl http://localhost:8010/health`. Xem logs: `docker logs infra-processing-service-1 --tail 50` |
| Không thấy highlight realtime | Đảm bảo `VITE_REALTIME_WS_ENABLED=true` trong file `.env` của frontend. Khởi động lại frontend sau khi sửa. Kiểm tra WebSocket connection ở browser console (F12 → Console) |
| WebSocket kết nối không được | Kiểm tra processing-api WebSocket config: `docker logs infra-processing-api-1 --tail 30`. Verify port 8082 đó open: `netstat -ano \| findstr 8082` |
| Database error | Kiểm tra postgres: `docker logs infra-db-1 --tail 30`. Đảm bảo port 5432 không conflict |
| Redis connection error | Kiểm tra redis: `docker logs infra-redis-1 --tail 30`. Verify port 6379 open: `redis-cli ping` (nếu redis-cli cài sẵn) |

---

## 5. Xác nhận hoàn tất Phase 1

Sau khi hoàn tất tất cả các bước kiểm tra thủ công ở trên, hãy xác nhận:

✅ **Frontend truy cập được**
✅ **Đăng nhập thành công với tài khoản e2e_test_user**
✅ **Upload audio và xử lý thành công**
✅ **Realtime mode (VITE_REALTIME_WS_ENABLED=true) hoạt động**: transcript cập nhật realtime khi job chạy
✅ **Polling fallback (VITE_REALTIME_WS_ENABLED=false) hoạt động**: job hoàn tất và kết quả hiển thị

Nếu tất cả đều ✅, **Phase 1 (Local Verification) hoàn tất thành công!**

---

## 6. Các lệnh hữu ích

### Khởi động/Dừng Stack

```powershell
# Khởi động toàn bộ stack
cd D:\Bin\EXE101\Thu_muc_moi
docker compose -f infra/docker-compose.dev.yml up -d

# Dừng toàn bộ stack
docker compose -f infra/docker-compose.dev.yml down

# Dừng và xóa volumes
docker compose -f infra/docker-compose.dev.yml down -v

# Khởi động lại một service cụ thể
docker compose -f infra/docker-compose.dev.yml restart web
docker compose -f infra/docker-compose.dev.yml restart user-api
docker compose -f infra/docker-compose.dev.yml restart processing-api
```

### Kiểm tra Logs

```powershell
# Xem logs của tất cả containers
docker compose -f infra/docker-compose.dev.yml logs

# Xem logs của một service cụ thể (50 dòng cuối)
docker logs infra-user-api-1 --tail 50
docker logs infra-processing-api-1 --tail 50
docker logs infra-web-1 --tail 50

# Follow logs realtime (Ctrl+C để dừng)
docker logs -f infra-web-1
```

### Health Check

```powershell
# User API
curl http://localhost:8083/actuator/health

# Processing API
curl http://localhost:8082/actuator/health

# Frontend
curl http://localhost:8080

# Diarization Service
curl http://localhost:8012/health
```

### Setup E2E Account

```powershell
cd D:\Bin\EXE101\Thu_muc_moi
.\scripts\setup-e2e-account.ps1
```

### Generate Test Audio

```powershell
cd D:\Bin\EXE101\Thu_muc_moi
python scripts/generate_test_wav.py
```

---

## 7. Ghi chú

- **Frontend port**: Mặc định chạy trên `8080` (Docker)
- **User API port**: `8083`
- **Processing API port**: `8082`, WebSocket endpoint: `ws://localhost:8082/ws`
- **Diarization Service port**: `8012`
- **Database**: PostgreSQL trên `localhost:5432` (credentials: `postgres/Audiomind@2`...)
- **Redis**: `localhost:6379`
- **Realtime WS endpoint**: Mặc định là `/ws` trên processing-api (port 8082)
- **Polling interval**: Mặc định khoảng 2-5 giây/lần khi realtime disabled

---

## 8. Liên hệ hỗ trợ

Nếu gặp vấn đề không có trong danh sách trên, vui lòng:
1. Kiểm tra logs chi tiết bằng lệnh Docker logs
2. Xem console browser (F12) để phát hiện lỗi client-side
3. Tham khảo file `docs/` hoặc README.md của các service

---

**Cập nhật lần cuối:** 2026-05-07
**Status:** ✅ Sẵn sàng cho Phase 1 Manual Testing
