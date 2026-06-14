# Audiomind — Google Integration Roadmap v2.6 Final

**Role:** Senior Solution Architect + Product/Security Technical Writer
**Revised:** June 2026 — final clean polish
**Status:** Ready for backlog (G0–G3.5), pending implementation slicing

---

## Changelog v2.5 → v2.6 Final

| Mục                               | Thay đổi                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Markdown cleanup**              | Fixed markdown/code fence issues.                                                                             |
| **Error/UX Mapping**              | Split Error/UX Mapping into Google/API errors and Browser Capture errors.                                     |
| **G4 warning**                    | Fixed G4 warning heading.                                                                                     |
| **G3.5 Non-goals**                | Added G3.5 Non-goals.                                                                                         |
| **G3.5 Implementation Slices**    | Added G3.5 Implementation Slices.                                                                             |
| **Browser smoke testing**         | Added manual browser smoke testing note.                                                                      |
| **Deepgram realtime config**      | Added Deepgram realtime language config verification.                                                         |
| **G3.5 dependency clarification** | Clarified G3.5 can work with externally-created Google Meet links and does not require Google OAuth/Calendar. |

---

## Changelog v2.4 → v2.5 Final

| Mục                                          | Thay đổi                                                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G3.5 Google Meet Vietnamese Support**      | Thêm phase mới: Browser Tab Audio Capture + Web Audio API mixing + Deepgram Vietnamese STT. Giải thích lý do mở song song Audiomind + Google Meet không đủ. |
| **Google Meet native transcript limitation** | Nhấn mạnh lại: tiếng Việt không hỗ trợ. G4 chỉ là pilot, không phải core cho VN.                                                                            |
| **Browser support**                          | Chuyển sang feature detection-first, không chỉ dựa vào browser name. Thêm note HTTPS/secure context.                                                        |
| **Video track handling**                     | Thêm cảnh báo: cần verify hành vi browser trước khi stop video track; MVP có thể giữ video track không dùng.                                                |
| **Speaker diarization limitation**           | Thêm section riêng: mixed stream không đảm bảo separation hoàn hảo, MVP focus vào completeness.                                                             |
| **Validation/hardening rules**               | Bổ sung: invalid capture ≠ no-speech, transcript rows = 0 → không gọi Gemini, one-active-session, stale session rejection, không log raw audio/deviceId.    |
| **Error/UX mapping**                         | Thêm các error code cho browser tab audio capture.                                                                                                          |
| **Testing plan**                             | Thêm G3.5 tests: unit FE, manual browser (Chrome/Edge, Firefox/Safari/mobile fallback), Vietnamese test script, negative tests.                             |
| **Architecture diagram**                     | Thêm realtime flow cho G3.5.                                                                                                                                |
| **Decision Matrix / Final Recommendation**   | Cập nhật: G3.5 là near-term/core cho VN users; G4 pilot; Meet Media API/drive recording delay.                                                              |
| **Sources**                                  | Thêm MDN `getDisplayMedia`, `getUserMedia`, Web Audio API, Deepgram Vietnamese STT.                                                                         |

---

## 1. Executive Summary

### Kết luận ngắn

| Hạng mục                                          | Quyết định                       | Lý do                                                                                     |
| ------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| **G1 Google Login**                               | ✅ Làm ngay                       | Friction thấp, scope không nhạy cảm, value cao                                            |
| **G2 Link Google Account**                        | ✅ Làm ngay                       | Nền bắt buộc cho Calendar/Meet features                                                   |
| **G3 Calendar + Meet link**                       | ✅ Làm sau G1/G2                  | Value rõ ràng, incremental consent                                                        |
| **G3.5 Google Meet Vietnamese tab audio capture** | ✅ Làm near-term (sau/đi cùng G3) | Core cho user Việt, không phụ thuộc Google native transcript                              |
| **G4 Transcript import (pilot)**                  | ⚠️ Làm sau, pilot                | **Tiếng Việt KHÔNG được hỗ trợ.** Chỉ có giá trị cho user Workspace nói 8 ngôn ngữ hỗ trợ |
| **G5 Artifact polling + analysis**                | ⚠️ Sau G4 pilot pass             | Phụ thuộc G4 adoption                                                                     |
| **G6 Meet Media API**                             | ❌ Delay                          | Developer Preview, tất cả participants phải enrolled                                      |
| **Bot/headless/scraping**                         | ❌ Không làm                      | ToS violation                                                                             |
| **Recording import qua Drive**                    | ❌ Delay                          | Restricted scope, security assessment 4–7 tuần                                            |

### Điểm then chốt nhất

> **Với Audiomind và user Việt Nam nói tiếng Việt:** Google Meet native transcript **không hỗ trợ tiếng Việt** (chỉ 8 ngôn ngữ: EN/FR/DE/IT/JA/KO/PT/ES).
> **Core flow cho Google Meet tiếng Việt:**
> User tạo/sử dụng Google Meet link → chọn mode “Ghi âm Google Meet” trong Audiomind → capture tab audio (+ mic) → Deepgram Vietnamese STT → Gemini analysis.
> **Google integration là additive, không thay thế Deepgram.**
> G4 transcript import chỉ là pilot cho Workspace + ngôn ngữ được hỗ trợ, không phải hướng chính cho VN.

G3.5 can work with any Google Meet tab, including externally-created Meet links. G3 Calendar scheduling improves UX by creating a Meet link inside Audiomind, but it is not technically required for browser tab audio capture. G3.5 does not require Google OAuth or Google Meet API access.

### Why opening Audiomind + Google Meet was not enough

Mở Audiomind song song với Google Meet chưa đủ nếu Audiomind chỉ đang thu microphone.

Remote participant audio trong Google Meet là tab/system audio, không tự động đi vào microphone stream. Nếu user dùng tai nghe, microphone gần như không nghe được remote audio. Vì vậy Audiomind cần một mode riêng để capture Google Meet tab audio hoặc system/tab audio capture, thay vì chỉ dựa vào microphone.

---

## 2. Bản đồ khả năng chính thức

> **Nguồn:** Google for Developers official docs, tháng 6/2026.

| Capability                                        | Google API/Product                | GA?                                    | Realtime?  | Cần approval đặc biệt?                    | MVP Suitability | Ghi chú quan trọng                                                                                                        |
| ------------------------------------------------- | --------------------------------- | -------------------------------------- | ---------- | ----------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Google Login (SSO)**                            | GIS + OIDC                        | ✅ GA                                   | N/A        | ❌ Không (chỉ `openid/email/profile`)      | ⭐⭐⭐⭐⭐           | Không sensitive nếu chỉ login                                                                                             |
| **Account linking**                               | OAuth 2.0 Code Flow               | ✅ GA                                   | N/A        | Sensitive khi xin Calendar/Meet scope     | ⭐⭐⭐⭐⭐           | Token vault ở backend                                                                                                     |
| **Calendar event + Meet link**                    | Calendar API v3                   | ✅ GA                                   | N/A        | `calendar.events` (sensitive)             | ⭐⭐⭐⭐            | Cần submit verification cho public app                                                                                    |
| **Quick Meet space**                              | Meet REST spaces.create           | ✅ GA                                   | N/A        | `meetings.space.created` (sensitive)      | ⭐⭐⭐⭐            | Không cần Calendar, persistent space                                                                                      |
| **Post-meeting transcript fetch**                 | Meet REST API v2                  | ✅ GA                                   | ❌          | `meetings.space.readonly` (sensitive)     | ⭐⭐              | Workspace plan + **chỉ 8 ngôn ngữ** + transcript phải bật                                                                 |
| **Post-meeting recording fetch**                  | Meet REST + Drive API             | ✅ GA                                   | ❌          | `drive.meet.readonly` (restricted)        | ⭐               | Restricted = security assessment 4–7 tuần                                                                                 |
| **Realtime Meet audio**                           | Meet Media API                    | ⚠️ Dev Preview                         | ✅          | Restricted + Developer Preview enrollment | ❌               | ALL participants phải enrolled trong Developer Preview                                                                    |
| **Realtime transcript từ Google**                 | Không có API                      | ❌                                      | N/A        | N/A                                       | ❌               | Không có public streaming caption API                                                                                     |
| **Bot/headless/capture**                          | Không chính thức                  | ❌                                      | Workaround | Vi phạm ToS                               | ❌               | Không recommend                                                                                                           |
| **Browser tab audio capture**                     | `getDisplayMedia` + Web Audio API | Browser-supported with user permission | ✅          | No Google approval                        | ⭐⭐⭐⭐            | User phải chọn Google Meet tab và bật share tab audio; MVP target Chrome/Edge desktop; fallback nếu không có audio track. |
| **Mic + tab audio mix**                           | `getUserMedia` + Web Audio API    | Browser-supported                      | ✅          | No Google approval                        | ⭐⭐⭐⭐            | Thu cả giọng user và audio từ Google Meet tab; cần xử lý echo/gain.                                                       |
| **Google Meet Vietnamese realtime transcription** | Audiomind tab capture + Deepgram  | ✅ via Audiomind, not Google native     | ✅          | No Google Meet transcript dependency      | ⭐⭐⭐⭐⭐           | Đây là hướng chính cho VN users.                                                                                          |

### ⚠️ Critical note: Google Meet Transcript — ngôn ngữ hỗ trợ

**Nguồn chính thức từ Google:**

* [Google Meet Help: Use transcripts](https://support.google.com/meet/answer/12849897)
* [Google Workspace Updates (tháng 3/2025)](https://workspaceupdates.googleblog.com/2025/03/google-meet-transcript-more-languages.html)

Tính đến 2026, native Google Meet transcript hỗ trợ đúng 8 ngôn ngữ: **English, French, German, Italian, Japanese, Korean, Portuguese, Spanish**. **Tiếng Việt không được hỗ trợ.**

Theo Google Workspace Updates, 7 ngôn ngữ ngoài tiếng Anh được rollout từ tháng 3/2025. Trước đó transcript chỉ có English. "Take notes for me" (Gemini smart notes) cũng chỉ hỗ trợ cùng 8 ngôn ngữ đó.

**Hệ quả với Audiomind:** G4 transcript import chỉ có giá trị cho user:

* Có Google Workspace Business Standard / Business Plus / Enterprise Starter / Enterprise Standard / Enterprise Plus / Teaching and Learning Upgrade / Education Plus / Workspace Individual.
* Meeting được tổ chức bằng một trong 8 ngôn ngữ được hỗ trợ.
* Đã bật Transcription trong meeting (hoặc pre-configured qua ArtifactConfig).

**Do đó, core flow cho Google Meet tiếng Việt là G3.5 (browser tab audio capture + Deepgram).**

---

## 3. Phased Roadmap

### Phase G0 — Google Cloud Setup (1–2 ngày)

**Goal:** Hạ tầng Google Cloud, khai báo scopes theo từng phase.

**Việc làm:**

* Tạo Google Cloud Project cho Audiomind production.
* Enable APIs: Google Identity, Calendar API v3, Meet REST API v2.
* Tạo OAuth 2.0 Client ID (Web Application), **tách riêng client cho dev/staging/production**.
* Cấu hình OAuth Consent Screen:

  * App name: Audiomind
  * Domain: audiomind.pro.vn
  * Authorized redirect URIs (chỉ exact URI, không wildcard):

    * Production: `https://user.audiomind.pro.vn/auth/google/callback`
    * Dev: `http://localhost:8083/auth/google/callback`
* Thêm test users (tối đa 100 users trước khi verification hoàn tất).
* Submit OAuth verification song song với development (nhất là sensitive scopes cho G3/G4).

**Scope declaration theo phase — dùng full URL constants:**

```
G1: openid, email, profile

G2:
- Scopes: openid, email, profile
- OAuth params: access_type=offline, prompt=consent
- Chỉ lưu refresh_token nếu Google trả về.

G3:
- Scopes: https://www.googleapis.com/auth/calendar.events
- OAuth params: access_type=offline, include_granted_scopes=true, prompt=consent khi cần refresh_token mới.

G4:
  - https://www.googleapis.com/auth/meetings.space.readonly — sensitive
  - https://www.googleapis.com/auth/meetings.space.settings — hiện official docs non-sensitive, nhưng verify Cloud Console trước production

G5+ (future):
  - Preferred: https://www.googleapis.com/auth/drive.meet.readonly (restricted)
  - Fallback only if official docs require: https://www.googleapis.com/auth/drive.readonly
```

**Hằng số scope (dùng trong code):**

```java
// Java/Spring constants example
public class GoogleScopes {
    public static final String OPENID = "openid";
    public static final String EMAIL = "email";
    public static final String PROFILE = "profile";
    public static final String CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
    public static final String MEET_SPACE_READONLY = "https://www.googleapis.com/auth/meetings.space.readonly";
    public static final String MEET_SPACE_SETTINGS = "https://www.googleapis.com/auth/meetings.space.settings";
    public static final String DRIVE_MEET_READONLY = "https://www.googleapis.com/auth/drive.meet.readonly";
    public static final String DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";

    // Meet Media API (verify exact scopes from official docs before use)
    public static final String MEET_MEDIA_READONLY = "https://www.googleapis.com/auth/meetings.conference.media.readonly";
    public static final String MEET_MEDIA_AUDIO_READONLY = "https://www.googleapis.com/auth/meetings.conference.media.audio.readonly";
    public static final String MEET_MEDIA_VIDEO_READONLY = "https://www.googleapis.com/auth/meetings.conference.media.video.readonly";
    public static final String MEET_SPACE_READ = "https://www.googleapis.com/auth/meetings.space.read";
}
```

**Acceptance Criteria:**

* OAuth consent screen configured và accessible.
* Test login với test Google account thành công.
* Không có scope nào request mà chưa cần dùng.

---

### Phase G1 — Google Login / SSO (3–5 ngày)

**Goal:** User đăng nhập Audiomind bằng Google Account.

**Quy tắc quan trọng của G1:**

* **Không** lưu refresh token.
* **Không** xin Calendar hay Meet scope.
* **Không** thay thế JWT flow hiện tại.
* **Không** trả Audiomind JWT trực tiếp từ callback GET (dùng one-time ticket).
* Chỉ verify danh tính, tạo/tìm user, tạo login ticket, redirect về FE.

**Backend changes (user-service):**

Flow mới (Option B – one-time login ticket) với OAuth state opaque:

```
1. FE: user bấm "Sign in with Google"
2. FE: gọi GET /auth/google/start
3. Backend:
   - Tạo opaque state (random 32+ bytes) → Redis key: google_oauth_state:{state}
   - Value: { mode: "login", nonce, redirectAfter (validated), createdAt }
   - TTL: 10 phút
   - Redirect đến Google OAuth với state=opaque_token
4. Google: user consent (openid, email, profile)
5. Google: redirect về /auth/google/callback?code=...&state=...
6. Backend:
   - GET+DELETE state từ Redis (atomic)
   - Nếu state không tồn tại → 400 GOOGLE_OAUTH_STATE_INVALID
   - Exchange code → ID token + short-lived access token
7. Backend: verify ID token (audience, expiry, signature) dùng thư viện chính thức cho Java/Spring (GoogleIdTokenVerifier)
8. Backend: find/create user theo google_sub
9. Backend: tạo one-time login ticket (opaque random token)
   - Redis key: `google_login_ticket:{ticketHash}` (hoặc dùng GETDEL)
   - Value: { userId, authFlowId, createdAt, redirectAfter? }
   - TTL: 60–120 giây
10. Backend: redirect về FE:
    https://app.audiomind.pro.vn/auth/google/success?ticket=<one_time_ticket>
11. FE (route /auth/google/success):
    - **Security:**
      - Không load bất kỳ analytics/third-party script nào trước khi xóa ticket khỏi URL.
      - Đọc ticket từ query.
      - Gọi POST /auth/google/exchange-ticket { ticket: "..." }
      - Sau khi nhận response (thành công hoặc lỗi), gọi `window.history.replaceState` để xóa `?ticket` khỏi URL.
      - Không lưu ticket vào localStorage/sessionStorage.
      - Không gửi ticket vào analytics/error tracking (Sentry, LogRocket, etc.).
    - **Headers khuyến nghị:**
      - `Referrer-Policy: no-referrer` hoặc `strict-origin`
12. Backend (exchange-ticket):
    - Atomic GETDEL redis key (hoặc GET + DEL)
    - Validate ticket (tồn tại, chưa hết hạn, chưa dùng)
    - Nếu ticket đã dùng nhưng còn trong used marker → GOOGLE_LOGIN_TICKET_USED
    - Issue Audiomind JWT
    - Trả { token, user }
13. FE lưu JWT như auth flow hiện tại.
```

**Xử lý email collision:**

```
Case 1: google_sub chưa có trong DB, email chưa có → tạo user mới với provider=google
Case 2: google_sub đã có → login thành công (tạo ticket)
Case 3: google_sub chưa có, email đã có (local user) → KHÔNG tự động merge
         → redirect về FE error route: https://app.audiomind.pro.vn/auth/google/error?errorCode=GOOGLE_EMAIL_CONFLICT
         → FE hiển thị message: "Email đã tồn tại. Đăng nhập rồi kết nối Google."
Case 4: google_sub khác, email giống google_email trong user_identities → reject
```

**⚠️ Điểm quan trọng:** Identity là `google_sub` (sub field trong ID token), **không phải email**. Email có thể thay đổi; sub là permanent identifier của Google account.

**DB changes:**

```sql
-- Thay đổi nhẹ bảng users
ALTER TABLE users
  ADD COLUMN auth_provider_primary VARCHAR(50) DEFAULT 'local';
-- 'local' | 'google' | ... (chỉ là primary method, không dùng để kiểm tra existence)

-- Bảng mới: identity per provider (xem phần DB Schema Hoàn chỉnh cho partial unique indexes)
```

**Endpoints (cập nhật):**

```
GET  /auth/google/start
  → Query: ?redirect_after=<url> (optional, phải nằm trong allowlist)
  → Tạo opaque state, lưu Redis, redirect đến Google OAuth
  → Auth: Public

GET  /auth/google/callback
  → Query: ?code=...&state=...
  → GET+DELETE state từ Redis
  → Xử lý code → ID token → user → tạo ticket → redirect FE success/error
  → Response: 302 redirect to FE (không trả JWT)
  → Errors: redirect về FE với errorCode (không kèm raw error/email/token)

POST /auth/google/exchange-ticket
  → Body: { ticket: string }
  → Response: { token: "<audiomind_jwt>", user: { id, email, name } }
  → Auth: Public
  → Errors: GOOGLE_LOGIN_TICKET_INVALID, GOOGLE_LOGIN_TICKET_USED (và GOOGLE_LOGIN_TICKET_EXPIRED nếu có expired marker)
```

**Google scopes:** `openid`, `email`, `profile` — **không sensitive, không cần verification riêng**.

**Acceptance Criteria:**

* Google login thành công → user nhận Audiomind JWT **qua exchange-ticket, không qua URL**.
* FE xóa ticket khỏi URL sau khi exchange, không gửi ticket vào analytics.
* Email collision → `GOOGLE_EMAIL_CONFLICT`, không auto-merge.
* Google sub là identity chính, không phải email.
* ID token wrong audience → reject 400.
* State không tồn tại hoặc đã dùng → 400.
* Ticket chỉ dùng một lần, TTL 60–120s, không log ticket value.
* Không lưu Google refresh token.
* Flow hiện tại (email/password) không bị ảnh hưởng.

**Tests (bổ sung):**

* Ticket exchange thành công → JWT trả về, ticket bị xoá (atomic).
* Exchange với ticket đã dùng → `GOOGLE_LOGIN_TICKET_USED`.
* Exchange với ticket hết hạn (nếu lưu marker) → `GOOGLE_LOGIN_TICKET_EXPIRED`; nếu không thì `INVALID`.
* FE route không gọi analytics trước khi xóa ticket (test bằng mock).
* Không có endpoint nào trả JWT trong URL.
* State value không xuất hiện trong logs.

---

### Phase G2 — Link Google Account (2–3 ngày)

**Goal:** User đã có tài khoản Audiomind kết nối Google, lưu token dùng cho Calendar/Meet về sau.

**Timing:** Sau G1. User đã login Audiomind xong mới link.

**Backend changes (user-service):**

```
POST /auth/google/link/start
  → Yêu cầu Audiomind JWT
  → Body: { "additionalScopes": ["https://www.googleapis.com/auth/calendar.events"] } (optional)
  → Tạo opaque state Redis (mode: "link", userId, requestedScopes, redirectAfter validated)
  → Redirect đến Google OAuth với scope: openid email profile + requestedScopes
  → OAuth params: access_type=offline, prompt=consent, include_granted_scopes=true

GET  /auth/google/link/callback
  → GET+DELETE state từ Redis
  → Exchange code → access_token + refresh_token + ID token
  → Kiểm tra: provider_sub đã link user khác chưa (chỉ active identity)
  → Lưu/revive encrypted refresh_token vào google_oauth_grants, kèm granted_scopes, token_kid
  → Thêm/revive row vào user_identities (nếu chưa có từ G1)
  → Redirect về FE success hoặc error route (KHÔNG trả JSON trực tiếp)
  → Success: https://app.audiomind.pro.vn/settings/integrations/google/success
  → Error: https://app.audiomind.pro.vn/settings/integrations/google/error?errorCode=GOOGLE_SCOPE_MISSING (chỉ errorCode)
  → Không đưa raw Google error, email, code, state, token vào URL.

DELETE /users/me/google/grant
  → Yêu cầu Audiomind JWT
  → Revoke refresh_token tại Google (gọi revocation endpoint)
  → Đánh dấu revoked_at = now() trong google_oauth_grants
  → Xóa Redis cache access token cho user (dùng index set)
  → Response: { success: true }
  → Lưu ý: KHÔNG xóa user_identities, user vẫn có thể login bằng Google

DELETE /users/me/google/identity
  → Yêu cầu Audiomind JWT
  → Kiểm tra user còn phương thức đăng nhập khác không (password_hash hoặc identity khác)
  → Nếu chỉ còn Google identity → 400 GOOGLE_CANNOT_UNLINK_LAST_IDENTITY
  → Set user_identities.unlinked_at = now() (soft delete)
  → Nếu có grant token đi kèm, gọi revoke và đánh dấu revoked_at, xóa Redis cache
  → Update users.auth_provider_primary nếu đang là 'google' → chuyển về 'local'
  → Response: { success: true }

GET  /users/me/google/status
  → Response: {
      linked: bool,                -- có identity active không (unlinked_at NULL)
      googleEmail: string | null,
      grantedScopes: string[],    -- từ google_oauth_grants (revoked_at NULL)
      missingScopes: string[]     -- scopes cần cho G3/G4 nhưng chưa có
    }
```

**DB changes:**

Xem phần DB Schema Hoàn chỉnh (partial unique indexes, revive logic, token_kid).

**Token Encryption + Key Rotation:**

```
Algorithm: AES-256-GCM
Key management:
- Hiện tại: GOOGLE_TOKEN_ENCRYPTION_KEY (32 bytes) với key id (kid) v1.
- Khi encrypt, lưu token_kid (ví dụ "v1").
- Khi decrypt, chọn key theo token_kid.
- Có job định kỳ re-encrypt grants cũ với key mới (chạy ngoài giờ cao điểm).
- Không log key, iv, token.

Cách encrypt:
  1. Generate random IV (12 bytes)
  2. Encrypt: ciphertext = AES-GCM(plaintext, key, iv)
  3. Lưu: encrypted_refresh_token = base64(ciphertext + authTag), token_iv = base64(iv), token_kid = current_kid
```

**Access token cache + index set:**

```
- Redis private network only, TLS, có mật khẩu.
- TTL <= 3500s (an toàn hơn 3600s).
- Key: google:access_token:{user_id}:{scope_hash}
- Index set: google:access_token_keys:{user_id} (chứa các key token của user)
- Khi cache token: SETEX key + SADD index_set key
- Khi revoke grant hoặc unlink identity:
    - SMEMBERS google:access_token_keys:{user_id}
    - DEL từng token key
    - DEL index set
- Không dùng Redis KEYS/scan trong request path.

Trước khi dùng access token:
  1. Check Redis key tồn tại → dùng luôn
  2. Key không có → decrypt refresh_token từ DB → call Google token endpoint → cache mới + thêm vào index set
  3. Google trả lỗi refresh_token invalid (invalid_grant) → revoked_at = now, xóa cache, trả GOOGLE_REFRESH_TOKEN_REVOKED
```

**Google OAuth params (quan trọng):**

* G2: `access_type=offline`, `prompt=consent` → để nhận refresh_token lần đầu.
* G3/G4 khi thêm scopes: `access_type=offline`, `include_granted_scopes=true`, `prompt=consent` (có thể cần để lấy refresh_token mới).

**Acceptance Criteria:**

* Link thành công: `google_oauth_grants` có active row, `user_identities` có active row.
* Cùng Google account link 2 users → `GOOGLE_ACCOUNT_ALREADY_LINKED` (kiểm tra active identity).
* Revoke grant: token revoked tại Google, DB updated (revoked_at), Redis cleared.
* Unlink identity: chỉ xóa identity nếu còn phương thức đăng nhập khác.
* Relink sau unlink: revive row cũ (unlinked_at = NULL) hoặc insert mới (partial unique đảm bảo chỉ một active).
* Link callback redirect về FE, không trả JSON trực tiếp.
* Không log bất kỳ token nào.

---

### Phase G3 — Calendar + Meet Scheduling (3–5 ngày)

**Goal:** Audiomind tạo meeting có Meet link cho user.

**User value:** User không cần rời Audiomind để tạo meeting link.

#### So sánh: Option A (Calendar API) vs Option B (Meet REST spaces.create)

| Tiêu chí                     | Option A: Calendar API             | Option B: Meet REST spaces.create         |
| ---------------------------- | ---------------------------------- | ----------------------------------------- |
| **Tạo lịch hẹn**             | ✅ Có thời gian, attendee, reminder | ❌ Không (persistent space, không có lịch) |
| **Invite email**             | ✅ Google gửi invite cho attendee   | ❌ Không                                   |
| **Calendar sync**            | ✅ Hiện trong Google Calendar       | ❌ Không                                   |
| **Pre-configure transcript** | Có (qua updateSpace sau)           | ✅ Có (ArtifactConfig khi create)          |
| **Scope**                    | `calendar.events` (sensitive)      | `meetings.space.created` (sensitive)      |
| **Complexity**               | Trung bình                         | Thấp hơn                                  |
| **Phù hợp use case**         | Scheduled meeting                  | Quick link / on-demand                    |

**Khuyến nghị cho Audiomind:**

* **Dùng Option A (Calendar API)** cho scheduled meeting có context (title, time, attendee).
* Có thể thêm Option B sau cho tính năng "tạo link nhanh" trong tương lai.

#### Option A: Calendar API Implementation

**Idempotency & double-click prevention (app-layer, không dùng header Idempotency-Key):**

* Mỗi Audiomind meeting chỉ có **một** active `google_calendar_link` (theo `meeting_id`, `user_id`).

* **Flow:**

  1. Bắt đầu transaction.
  2. Kiểm tra `google_calendar_links` theo `(meeting_id, user_id)`.
  3. Nếu tồn tại row với `creation_status` là `creating` hoặc `success`:

     * Trả về status hiện tại (pending hoặc success), không gọi lại Google API.
  4. Nếu chưa có, tạo placeholder row với:

     * `audiomind_calendar_request_id` = UUID (duy nhất)
     * `creation_status` = `'creating'`
     * `google_calendar_event_id` = NULL (cho phép NULL)
  5. Gọi Google Calendar API, dùng `conferenceData.createRequest.requestId` ổn định cho mỗi attempt (ví dụ `audiomind-{meeting_id}-{attempt_timestamp}`).
  6. Nếu thành công: update row với `google_calendar_event_id`, `meet_uri`, `hangout_link`, `conference_id`, `creation_status='success'`.
  7. Nếu thất bại terminal (lỗi scope, validation): `creation_status='failed'`, lưu `error_code`.
  8. Nếu thất bại temporary (network timeout, 5xx): giữ `creating`, retry sau (có backoff).

* **Double-click / concurrent request:**

  * Dùng unique constraint trên `(meeting_id, user_id)` hoặc row lock (`SELECT FOR UPDATE`) để tránh race.
  * Nếu placeholder đã tồn tại, request thứ hai trả về `GOOGLE_CALENDAR_CREATION_IN_PROGRESS` (202) và FE poll.

**API Call (Calendar API v3) – KHÔNG dùng Idempotency-Key header:**

```http
POST https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "summary": "Audiomind — {meeting.title}",
  "description": "Recording sẽ được phân tích tự động bởi Audiomind.",
  "start": { "dateTime": "2026-06-15T10:00:00+07:00", "timeZone": "Asia/Ho_Chi_Minh" },
  "end":   { "dateTime": "2026-06-15T11:00:00+07:00", "timeZone": "Asia/Ho_Chi_Minh" },
  "attendees": [{ "email": "attendee@example.com" }],
  "conferenceData": {
    "createRequest": {
      "requestId": "<stable-request-id-for-retry>",   // ổn định cho mỗi attempt
      "conferenceSolutionKey": { "type": "hangoutsMeet" }
    }
  }
}
```

**Response quan trọng:**

```json
{
  "id": "google_calendar_event_id",
  "conferenceData": {
    "conferenceId": "...",
    "conferenceSolution": { "name": "Google Meet" },
    "entryPoints": [{ "entryPointType": "video", "uri": "https://meet.google.com/xxx-yyy-zzz" }],
    "createRequest": { "status": { "statusCode": "success" } }
  },
  "hangoutLink": "https://meet.google.com/xxx-yyy-zzz"
}
```

> **Note:** `status.statusCode` ban đầu có thể là `pending`. Re-fetch sau 2–3 giây nếu pending. `hangoutLink` là Meet URI cần lưu.

**MVP Scope: Update/Cancel Behavior**

* **Rename Audiomind meeting** → không tự động update Google Calendar event.
* **Delete Audiomind meeting** → không tự động cancel Google Calendar event.
* Nếu cần cancel, phải có explicit future endpoint: `DELETE /meetings/{id}/google/calendar-event`.
* Tương lai có thể implement:

  * `PATCH` calendar event khi title/time/attendees thay đổi.
  * `DELETE` calendar event với user confirmation.

**Backend changes (meeting-service):**

```
POST /meetings/{id}/google/calendar-event
  → Require Audiomind JWT, owner gate
  → Gọi user-service internal endpoint: POST /internal/google/access-token (userId, scopes)
  → Nếu user chưa grant calendar.events → trả GOOGLE_SCOPE_MISSING → FE trigger incremental consent
  → Kiểm tra existing google_calendar_link (theo meeting_id, user_id)
    - Nếu tồn tại và creation_status = 'success' → return existing link
    - Nếu creation_status = 'creating' → return 202 GOOGLE_CALENDAR_CREATION_IN_PROGRESS
  → Tạo placeholder row với creation_status='creating', audiomind_calendar_request_id
  → Gọi Calendar API (dùng requestId ổn định)
  → Nếu thành công: update row, trả về meet_uri
  → Nếu thất bại terminal: set creation_status='failed', trả lỗi phù hợp
  → Nếu thất bại temporary: giữ 'creating', lên lịch retry, trả 202

GET  /meetings/{id}/google/status
  → Trả tổng hợp: calendar link (nếu success), creation_status, import job status
```

**Incremental consent flow:**

```
FE: gọi POST /meetings/{id}/google/calendar-event
Backend: trả 403 GOOGLE_SCOPE_MISSING { missingScopes: ['https://www.googleapis.com/auth/calendar.events'] }
FE: hiện dialog "Audiomind cần quyền truy cập Google Calendar"
FE: redirect đến /auth/google/link/start?additionalScopes=https://www.googleapis.com/auth/calendar.events
Backend: OAuth consent với scopes bổ sung (access_type=offline, include_granted_scopes=true)
Backend: lưu/update granted_scopes mới vào google_oauth_grants (revive nếu cần)
FE: retry POST /meetings/{id}/google/calendar-event
```

**DB changes:**

Xem DB Schema Hoàn chỉnh (lưu ý microservice boundary).

**Google scopes:** `https://www.googleapis.com/auth/calendar.events` (sensitive)

**Acceptance Criteria:**

* Meeting có Meet link sau khi user authorize Calendar scope.
* `status.statusCode = pending` → poll, đợi success.
* Double-click create link → chỉ một placeholder row, một Google API call.
* User chưa grant `calendar.events` → `GOOGLE_SCOPE_MISSING`, FE trigger consent.
* Token expired → auto refresh, retry.
* Rename/delete meeting không ảnh hưởng Google Calendar (theo MVP).
* Không lưu access token ở FE.
* `google_calendar_event_id` nullable khi đang tạo.

---

### Phase G3.5 — Google Meet Vietnamese Support via Browser Tab Audio Capture

**Goal:** Cho phép user ghi âm Google Meet tiếng Việt bằng cách capture audio từ Google Meet tab và/hoặc microphone, rồi đưa vào Deepgram realtime pipeline hiện tại.

**User value:**

* Hỗ trợ cuộc họp tiếng Việt.
* Không phụ thuộc Google Meet native transcript.
* Không yêu cầu Google Workspace transcript.
* Không yêu cầu Meet Media API Developer Preview.
* Không cần bot/headless/scraping.

G3.5 can work with any Google Meet tab, including externally-created Meet links. G3 Calendar scheduling improves UX by creating a Meet link inside Audiomind, but it is not technically required for browser tab audio capture. G3.5 does not require Google OAuth or Google Meet API access.

#### G3.5 Non-goals

* Không implement Google Meet Media API.
* Không implement bot/headless capture.
* Không implement browser extension.
* Không implement Google native transcript import.
* Không yêu cầu Google Workspace transcript.
* Không yêu cầu perfect speaker diarization.
* Không refactor toàn bộ realtime pipeline nếu có thể reuse pipeline hiện tại.
* Không thay Deepgram/Gemini.

#### UX flow

1. User tạo hoặc sử dụng Google Meet link, từ G3 hoặc từ bên ngoài.
2. User mở Audiomind.
3. User chọn mode: **"Ghi âm Google Meet"** trong recording source selector.
4. Audiomind hiển thị hướng dẫn:

   * Chọn tab Google Meet trong browser picker.
   * Bật checkbox **"Share tab audio"** / **"Chia sẻ âm thanh của tab"**.
   * Nếu muốn ghi cả giọng của mình, cho phép microphone.
5. Browser hiển thị share picker.
6. User chọn đúng Google Meet tab.
7. Audiomind kiểm tra `displayStream.getAudioTracks().length`.
8. Nếu có tab audio, bắt đầu realtime stream vào Deepgram với Vietnamese meeting mode.
9. Nếu có mic, mix mic + tab audio bằng Web Audio API.
10. User stop recording.
11. Audiomind finalize transcript.
12. Gemini analysis/action plan/export chạy như realtime flow hiện tại.

#### Capture modes

| Mode                        | Source          | API                                                | Use case                                        | Pros                                   | Cons                                                                        |
| --------------------------- | --------------- | -------------------------------------------------- | ----------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| **A — Microphone only**     | Mic             | `getUserMedia`                                     | Existing flow, thu giọng user                   | Đơn giản, hoạt động trên nhiều browser | Không thu được remote audio đáng tin cậy khi user dùng tai nghe             |
| **B — Tab audio only**      | Google Meet tab | `getDisplayMedia({ video: true, audio: true })`    | Thu remote Google Meet audio                    | Thu được remote audio                  | Không thu được mic riêng; video track có thể cần giữ sống tùy browser       |
| **C — Tab audio + Mic mix** | Tab + mic       | `getDisplayMedia` + `getUserMedia` + Web Audio API | **Recommended mode** cho Google Meet tiếng Việt | Thu được remote audio và local mic     | Phức tạp hơn; cần browser hỗ trợ; không đảm bảo speaker separation hoàn hảo |

#### Technical design — FE

* **Recording source selector:** Microphone / Google Meet tab audio / Google Meet tab + microphone.

* **Tab capture:**

  ```ts
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  const tabAudioTracks = displayStream.getAudioTracks();
  if (tabAudioTracks.length === 0) {
    throw new Error("TAB_AUDIO_NOT_SHARED");
  }
  ```

* **Mic capture:**

  ```ts
  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  ```

* **Mixing (mode C):**

  ```ts
  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  audioContext.createMediaStreamSource(displayStream).connect(destination);
  audioContext.createMediaStreamSource(micStream).connect(destination);

  const mixedStream = destination.stream;
  ```

* **Send to existing realtime pipeline:** reuse WebSocket, `useAudioRecorder` / `useRealtimeMeetingStream` if compatible.

* **UI status indicators:**

  * "Tab audio detected".
  * "No tab audio track detected".
  * "Mic detected".
  * "Capture ended".

* **Guide overlay** cho Chrome/Edge share picker.

> **⚠️ Video track handling note:** Trước khi implement, cần verify hành vi browser khi stop video track. Trong một số browser, việc stop video track có thể kết thúc toàn bộ session capture. MVP nên **giữ video track không dùng** hoặc test kỹ trên Chrome/Edge trước khi quyết định. Verify with official docs / target browser test before implementation.

#### Technical design — Backend

* **No new Google API required.**

* **No Google OAuth required for G3.5.**

* **No G3 Calendar dependency:** G3.5 có thể hoạt động với Meet link do Audiomind tạo hoặc link Google Meet bên ngoài.

* **Existing processing-service realtime STT path** được tái sử dụng.

* **ai-service / Deepgram:** giữ Deepgram là STT mặc định; chỉ thêm language hint/config nếu cần.

* **Thêm metadata vào meeting/transcript** nếu schema hiện tại hỗ trợ JSON metadata:

  ```json
  {
    "recording_source": "browser_tab_plus_mic",
    "meeting_platform": "google_meet",
    "tab_audio_detected": true,
    "mic_detected": true,
    "browser": "Chrome",
    "language_hint": "vi"
  }
  ```

* **Không gọi Gemini nếu transcript rows = 0**.

Before implementation, verify current Deepgram model/language config used by `ai-service` realtime path. Prefer explicit `language=vi` for Vietnamese meeting mode if supported by the current Deepgram SDK/config. If the current pipeline uses auto language detection, keep it only if Vietnamese smoke tests pass. Log only safe metadata, never raw transcript/audio/provider response.

#### Browser support / limitations

**MVP target:** Desktop Chrome / Edge / Chromium-based browsers first.

**Feature detection, không chỉ dựa vào browser name:**

* Kiểm tra `navigator.mediaDevices?.getDisplayMedia`.
* Sau khi user chọn, kiểm tra `stream.getAudioTracks().length`.
* Nếu không có audio track, hiển thị `TAB_AUDIO_NOT_SHARED` hoặc `NO_AUDIO_TRACK_DETECTED`.

**Known limitations cần verify với official docs và test trên target browser:**

* Browser không thể silently capture tab khác.
* User phải manually chọn đúng Google Meet tab/window/screen.
* User thường phải bật “Share tab audio” trong picker.
* Khả năng có audio track phụ thuộc browser, OS, quyền, và nguồn được chọn.
* Firefox và Safari hiện không đáng tin cậy cho tab audio capture; MVP coi là unsupported unless feature detection confirms usable audio track.
* Mobile browsers không hỗ trợ `getDisplayMedia`; không hỗ trợ tab audio capture.
* **Yêu cầu HTTPS/secure context** hoặc localhost dev để browser cho phép `getDisplayMedia` và `getUserMedia`.

#### Privacy / consent

* User phải chủ động bắt đầu capture; không auto-start.
* Browser permission required.
* UI phải hiển thị recording indicator: đèn đỏ, text "Đang ghi âm Google Meet".
* Giải thích chính xác những gì được capture: tab audio, mic, hay cả hai.
* Không auto-start capture sau khi tạo Meet link.
* Không hidden recording, không bot/headless.
* Stop capture khi user stop recording hoặc track ends.
* **Không log raw audio, raw transcript, deviceId, token.**

#### Speaker / diarization limitation

Tab audio + mic mix gửi một mixed audio stream đến STT. Điều này cải thiện completeness nhưng **không đảm bảo perfect speaker separation**. MVP acceptance nên tập trung vào transcript completeness cho meeting tiếng Việt, không yêu cầu diarization hoàn hảo. Tương lai có thể nghiên cứu separate-channel streaming nếu pipeline hỗ trợ.

#### Validation / hardening rules

G3.5 phải giữ các validation/hardening rules hiện tại của realtime pipeline:

* **Invalid capture ≠ no-speech:** nếu không có audio track, fail fast với user-facing error, không chờ timeout.
* **Transcript rows = 0 → không gọi Gemini analysis.**
* **One-active-recording-session guard:** không cho phép hai recording session đồng thời cho cùng meeting/user.
* **Reject stale recordingSessionId / attemptId.**
* **Xử lý ended display track:** lắng nghe sự kiện `track.onended`, stop/finalize safely.
* **Không log raw audio, raw transcript, prompt, provider response, deviceId, token.**

#### G3.5 Acceptance Criteria

* User có thể chọn mode Microphone / Google Meet tab / Tab + Mic.
* Chrome/Edge desktop phát hiện được tab audio khi user chọn đúng Meet tab và bật share tab audio.
* Nếu không có audio track, flow fail fast bằng `TAB_AUDIO_NOT_SHARED` hoặc `NO_AUDIO_TRACK_DETECTED`.
* Tab + Mic mode gửi mixed stream vào realtime WebSocket path hiện tại.
* Transcript tiếng Việt xuất hiện bằng Deepgram realtime path hiện tại.
* Gemini chỉ chạy khi có transcript rows.
* User deny mic vẫn có thể tiếp tục tab-only nếu tab audio hợp lệ.
* User deny display capture không tạo recording session treo.
* Track ended event stop/finalize safely.
* Không log raw audio, raw transcript, provider response, token, hoặc deviceId.

#### G3.5 Implementation slices

G3.5 không nên implement một lần quá lớn. Nên tách thành các slice:

1. **G3.5-A — FE source selector + permission UX**

   * Thêm selector: Microphone / Google Meet tab / Tab + Mic.
   * Thêm hướng dẫn chọn tab Google Meet và bật share tab audio.
   * Thêm unsupported browser fallback.

2. **G3.5-B — Tab audio capture + detection**

   * Implement `getDisplayMedia`.
   * Detect `displayStream.getAudioTracks().length`.
   * Handle cancel/no-audio/ended track.
   * Không nối mixer vội nếu chưa cần.

3. **G3.5-C — Tab + mic mixer**

   * Implement `getUserMedia`.
   * Mix tab audio + mic bằng Web Audio API.
   * Handle `AudioContext` failure.
   * Không yêu cầu diarization hoàn hảo.

4. **G3.5-D — Realtime pipeline integration + metadata**

   * Reuse existing realtime WebSocket path.
   * Add metadata: `recording_source`, `meeting_platform`, `language_hint`.
   * Ensure no Gemini call when transcript rows = 0.

5. **G3.5-E — ErrorUX + tests + manual smoke**

   * Add ErrorUX mapping.
   * Unit test mocks for browser APIs.
   * Manual Chrome/Edge smoke test with Vietnamese script.

#### Error / UX mapping cho G3.5

Xem bảng đầy đủ trong section 8 — Error / UX Validation Mapping.

---

### Phase G4 — Post-meeting Transcript Import (Pilot) (5–7 ngày)

**⚠️ Điều kiện tiên quyết không thể bypass — cần hiển thị rõ cho user:**

Google Meet native transcript **không hỗ trợ tiếng Việt**. G4 chỉ có giá trị cho user Workspace meeting bằng 8 ngôn ngữ được hỗ trợ. Đối với user Việt Nam, core flow là **G3.5 browser tab audio capture + Deepgram**.

```txt
1. Google Workspace edition hỗ trợ:
   Business Standard / Business Plus / Enterprise Starter /
   Enterprise Standard / Enterprise Plus /
   Teaching and Learning Upgrade / Education Plus / Workspace Individual

2. Ngôn ngữ meeting phải là 1 trong 8: EN, FR, DE, IT, JA, KO, PT, ES
   → TIẾNG VIỆT KHÔNG ĐƯỢC HỖ TRỢ

3. Transcription phải được BẬT trong meeting
   (hoặc pre-configured qua ArtifactConfig — xem dưới)

4. User phải là meeting organizer hoặc participant có quyền truy cập

5. Transcript entries chỉ available trong 30 ngày sau meeting
```

#### Pre-configure ArtifactConfig (cải thiện UX)

Khi tạo meeting space, có thể pre-configure `ArtifactConfig` gồm `recordingConfig`, `transcriptionConfig`, `smartNotesConfig`. **Meeting organizers (không phải co-host)** có thể pre-configure auto-recording, auto-transcripts, và smart notes. Scope yêu cầu: `meetings.space.settings`.

> **Caveat quan trọng:**
>
> * Chỉ meeting organizer mới có quyền pre-configure auto artifacts.
> * Workspace policy/edition phải cho phép (không phải cách bypass).
> * Nếu patch ArtifactConfig fail, Calendar meeting vẫn được tạo; chỉ cần đánh dấu là artifact config unavailable/failed.
> * **Classification:** Official docs hiện classify `meetings.space.settings` là non-sensitive, nhưng **verify trong Google Cloud Console trước production** vì có thể thay đổi.

Audiomind có thể gọi `spaces.patch` sau khi tạo Calendar event để bật auto-transcription. **Cần dùng `updateMask` để tránh ghi đè các config khác và đúng chuẩn PATCH của Google.**

```http
PATCH https://meet.googleapis.com/v2/spaces/{space}?updateMask=config.artifactConfig.transcriptionConfig
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "config": {
    "artifactConfig": {
      "transcriptionConfig": {
        "autoTranscriptionGeneration": "ON"
      }
    }
  }
}
```

> **Trước khi implement:** kiểm tra chính xác đường dẫn `updateMask` trong tài liệu Google Meet spaces.patch (có thể cần `config.artifactConfig.transcriptionConfig.autoTranscriptionGeneration`). Không patch toàn bộ `config` nếu không cần.

#### Meet REST API Flow — tìm Conference Record

```
Cách 1 (từ hangoutLink đã lưu):
  Extract meet_code từ "https://meet.google.com/xxx-yyy-zzz"
  → GET /v2/conferenceRecords?filter=space.meeting_code="xxx-yyy-zzz"
  → Lấy conferenceRecord gần nhất có endTime

Cách 2 (từ Calendar event):
  Dùng conferenceId → GET /v2/spaces/{space}
  → Dùng space.name → GET /v2/conferenceRecords?filter=space.name="spaces/..."

Cách 3 (user nhập tay):
  User paste Meet link → parse code → tìm conference record
```

#### Fetch Transcript Entries

```
GET https://meet.googleapis.com/v2/{conferenceRecord}/transcripts
→ Lấy transcript gần nhất có state = ENDED

GET https://meet.googleapis.com/v2/{transcript}/entries?pageSize=100
→ Paginate đến hết (nextPageToken)

TranscriptEntry fields:
  - text: nội dung speech
  - participant: { signedinUser: { user: "users/..." } }
  - languageCode: "en-US"
  - startTime / endTime: timestamps
  - (không có confidence field — Google không trả)
```

#### Normalize vào Audiomind transcript

```
TranscriptEntry → transcript_segment (hoặc bảng hiện tại):
  text         → content
  participant  → speaker_label (lookup participants API để lấy displayName)
  startTime    → timestamp_start_ms
  endTime      → timestamp_end_ms
  languageCode → language
  confidence   → null (Google không cung cấp)
  source       → 'google_meet_api'
```

#### Xử lý unsupported language / no artifact (không set quá sớm)

**Quan trọng:** Google Meet API chỉ trả transcript entries nếu ngôn ngữ được hỗ trợ và transcript được bật. Nếu không, API sẽ không trả artifact hoặc trả danh sách rỗng.

Logic xử lý (có polling deadline):

```
1. Gọi conferenceRecords → không tìm thấy conference record (meeting chưa kết thúc hoặc không tồn tại)
   → status = 'polling', next_retry_at = now + backoff (tăng dần)
   → FE hiển thị "Đang chờ Google Meet xử lý transcript..."

2. Tìm thấy conference record, gọi transcripts → list rỗng hoặc không có transcript nào ENDED
   → Nếu chưa quá polling deadline (2 giờ) và attempt < max_attempts:
        status = 'polling', lên lịch retry.
   → Nếu đã hết deadline hoặc max_attempts:
        status = 'no_artifact'
        FE message: "Không tìm thấy transcript Google Meet. Lý do có thể: (1) Transcription chưa được bật, (2) Ngôn ngữ không được hỗ trợ (Google Meet chỉ hỗ trợ: EN/FR/DE/IT/JA/KO/PT/ES), (3) Workspace plan không hỗ trợ."

3. Tìm thấy transcript, gọi entries → entries có dữ liệu
   → Kiểm tra languageCode của entry đầu tiên (hoặc transcript resource)
   → Nếu languageCode không nằm trong allowlist (en, fr, de, it, ja, ko, pt, es) → status = 'unsupported_language'
   → FE message: "Google Meet transcript không hỗ trợ ngôn ngữ này. Hãy upload audio để Audiomind transcribe."
   → Nếu languageCode hỗ trợ → import bình thường
```

**DB changes:**

Xem DB Schema Hoàn chỉnh.

**Polling schedule (tối đa 2 giờ):**

```
Attempt 1: +0 phút (ngay sau job tạo)
Attempt 2: +5 phút
Attempt 3: +10 phút
Attempt 4: +20 phút
Attempt 5: +30 phút
Attempt 6: +60 phút
Attempt 7: +90 phút
Attempt 8: +120 phút → status = no_artifact nếu vẫn không có transcript
```

**Fallback UX:**

```
Khi status = no_artifact hoặc unsupported_language:
→ FE hiển thị message rõ nguyên nhân
→ Cung cấp nút "Upload audio để Audiomind transcribe" → fallback vào Deepgram flow hiện tại
```

**Feed vào Analysis:**

```
Sau khi transcript entries imported:
→ Mark source = 'google_meet_api' trong meeting
→ Gọi existing re-analyze v2 pipeline
→ Gemini analysis chạy như bình thường
→ KHÔNG thay đổi analysis pipeline
```

**Google scopes:**

* `meetings.space.readonly` (sensitive — cần verification)
* `meetings.space.settings` (hiện non-sensitive, verify Cloud Console)

**Acceptance Criteria:**

* Transcript import thành công → Gemini analysis chạy với source = 'google_meet_api'.
* No transcript artifact → chỉ set `no_artifact` sau khi hết polling deadline.
* Unsupported language (ví dụ tiếng Việt nếu có transcript lạ) → `unsupported_language`, FE message rõ.
* Permission denied (user không phải organizer/participant) → `GOOGLE_PERMISSION_DENIED`.
* Duplicate import → idempotent, không tạo thêm entries.
* Transcript entries có speaker label từ participants API.
* Polling dừng sau 2 giờ.

---

### Phase G5 — Full Artifact Polling + Analysis (3–4 ngày)

**Goal:** Hoàn thiện G4, gắn với Google Workspace Events API (webhook thay vì polling).

**Backend changes:**

* Subscribe Google Workspace Events API để nhận push notification khi transcript sẵn sàng.
* Thay polling bằng event-driven trigger (giảm API calls).
* Gắn `conference_record_name` vào meeting sau khi meeting kết thúc.

**G5 recording import (future):** Scope ưu tiên `drive.meet.readonly` (restricted). Fallback `drive.readonly` chỉ nếu official docs yêu cầu. Delay đến khi có security assessment / customer requirement.

---

### Phase G6 — Meet Media API Realtime POC (Không deploy production)

Để dùng Meet Media API, Google Cloud project, OAuth principal, **và tất cả participants trong conference** đều phải enrolled trong Developer Preview Program.

Meet Media API không cung cấp transcript stream — chỉ có audio/video raw. Cần dùng STT provider riêng. Chỉ gửi audio của 3 participants "most relevant" tại một thời điểm.

**Exact scopes (verify official docs before implementation):**

* `https://www.googleapis.com/auth/meetings.conference.media.readonly`
* `https://www.googleapis.com/auth/meetings.conference.media.audio.readonly`
* `https://www.googleapis.com/auth/meetings.conference.media.video.readonly`
* `https://www.googleapis.com/auth/meetings.space.read`

**Kết luận:** Không implement cho pre-beta. Chỉ làm POC nội bộ khi:

* Meet Media API đạt GA.
* Không còn yêu cầu tất cả participants enrolled.
* Có enterprise customer trả tiền với nhu cầu rõ ràng.

---

### Phase G7 — Third-party Capture (Enterprise tier, tương lai xa)

| Provider     | Model                           | Cost                    | Phù hợp                             |
| ------------ | ------------------------------- | ----------------------- | ----------------------------------- |
| Recall.ai    | Bot participant, cross-platform | ~$0.5–2/giờ/bot         | Enterprise tier, multi-platform     |
| Nylas        | Calendar + meeting intelligence | Per call                | Enterprise với calendar integration |
| Tự build bot | Headless browser                | Dev cost cao + ToS risk | KHÔNG recommend                     |

Chỉ xem xét khi có enterprise customer requirement rõ ràng.

---

## 4. Architecture — Service Responsibility

### Nguyên tắc

1. **user-service: token vault duy nhất**

   * Tất cả Google OAuth flows.
   * Encrypted refresh token storage.
   * Cấp access token cho service khác qua internal endpoint.
   * Không service nào đọc `google_oauth_grants` trực tiếp.

2. **meeting-service: Calendar scheduling**

   * Tạo Calendar event + Meet link.
   * Lưu `meet_uri`, `conferenceId`.
   * Không giữ Google token lâu dài.

3. **processing-service: Artifact import + analysis**

   * Import transcript entries.
   * Normalize thành Audiomind format.
   * Trigger existing Gemini pipeline.
   * Không giữ Google token lâu dài.

4. **FE-Audiomind: browser capture cho G3.5**

   * `getDisplayMedia`.
   * `getUserMedia`.
   * Web Audio API mixer.
   * Reuse realtime WebSocket pipeline.

5. **Scheduler: Job runner**

   * Poll `google_import_jobs`.
   * Gọi processing-service internal API.
   * Có thể là cron trong processing-service hoặc standalone.

6. **Không tách google-integration-service ngay**

   * Tăng complexity không cần thiết ở pre-beta.
   * Có thể tách sau khi Google integration lớn hơn.

### Google Meet Vietnamese realtime flow (G3.5)

```txt
User browser
  ├─ Google Meet tab audio via getDisplayMedia
  ├─ Microphone via getUserMedia
  └─ Web Audio mixer
        ↓ mixed MediaStream
FE-Audiomind realtime WebSocket
        ↓
processing-service / ai-service existing realtime path
        ↓
Deepgram Vietnamese STT
        ↓
canonical transcript
        ↓
Gemini analysis/action plan/export
```

### Microservice DB Boundary Note

> **Cảnh báo:** Audiomind có nhiều service (user-service, meeting-service, processing-service). Các bảng trong DB Schema dưới đây có thể nằm trong cùng một database hoặc mỗi service có database riêng. Tuỳ kiến trúc thực tế mà áp dụng quy tắc:
>
> * **Nếu các service dùng chung database/schema**: có thể dùng Foreign Key thật giữa các bảng, ví dụ `google_calendar_links.meeting_id REFERENCES meetings(id)`.
> * **Nếu mỗi service có database riêng** (khuyến nghị cho phân tách lâu dài):
>
>   * `user-service` sở hữu: `users`, `user_identities`, `google_oauth_grants`.
>   * `meeting-service` sở hữu: `google_calendar_links`; chỉ lưu `user_id`, `meeting_id` dạng scalar, không FK cross-service.
>   * `processing-service` sở hữu: `google_import_jobs`, `google_meet_artifacts`; chỉ lưu scalar `user_id`, `meeting_id`.
>   * Tính toàn vẹn tham chiếu được đảm bảo bằng **owner gate** và **internal service calls**, không dùng FK giữa các database.
>   * Migration phải nằm đúng service sở hữu bảng đó.

Trong các câu lệnh SQL mẫu dưới đây, chúng tôi để `REFERENCES` để thể hiện ý đồ, nhưng cần điều chỉnh theo kiến trúc DB thực tế.

---

## 5. DB Schema Hoàn chỉnh

> **Lưu ý quan trọng:** Thay `BIGINT` bằng kiểu ID thực tế của từng service (BIGSERIAL, UUID, etc.) để khớp với schema hiện tại của Audiomind.

### user_identities (mới) – sở hữu bởi user-service

```sql
CREATE TABLE user_identities (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,   -- scalar user id; FK only if same DB/schema
  provider        VARCHAR(50) NOT NULL,
  provider_sub    VARCHAR(255) NOT NULL,
  provider_email  VARCHAR(255),
  email_verified  BOOLEAN DEFAULT false,
  display_name    VARCHAR(255),
  avatar_url      TEXT,
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ,
  unlinked_at     TIMESTAMPTZ
);

-- Chỉ cho phép một active identity (unlinked_at IS NULL) cho mỗi (provider, provider_sub)
CREATE UNIQUE INDEX ux_active_identity_provider_sub
  ON user_identities(provider, provider_sub)
  WHERE unlinked_at IS NULL;

-- Chỉ cho phép một active identity cho mỗi (user_id, provider)
CREATE UNIQUE INDEX ux_active_identity_user_provider
  ON user_identities(user_id, provider)
  WHERE unlinked_at IS NULL;

CREATE INDEX idx_user_identities_user ON user_identities(user_id);
```

**Logic relink / revive:**

* Nếu user link lại cùng Google account đã từng unlinked, có thể **revive** row cũ bằng cách `UPDATE SET unlinked_at = NULL, linked_at = now(), last_login_at = now()` thay vì insert mới.
* Nếu Google account đang active (unlinked_at NULL) ở một user khác → trả lỗi `GOOGLE_ACCOUNT_ALREADY_LINKED`.

### google_oauth_grants (mới – G2+) – sở hữu bởi user-service

```sql
CREATE TABLE google_oauth_grants (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 BIGINT NOT NULL,   -- scalar, FK only if same DB/schema
  google_sub              VARCHAR(255) NOT NULL,
  encrypted_refresh_token TEXT,
  token_iv                VARCHAR(255),
  token_kid               VARCHAR(100),      -- key id for rotation
  granted_scopes          TEXT[] NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at              TIMESTAMPTZ
);

-- Chỉ một active grant (revoked_at IS NULL) cho mỗi user
CREATE UNIQUE INDEX ux_active_google_grant_user
  ON google_oauth_grants(user_id)
  WHERE revoked_at IS NULL;

-- Chỉ một active grant cho mỗi google_sub
CREATE UNIQUE INDEX ux_active_google_grant_sub
  ON google_oauth_grants(google_sub)
  WHERE revoked_at IS NULL;
```

**Logic regrant / revive:**

* Nếu có grant cũ bị revoked (`revoked_at IS NOT NULL`), khi user link lại hoặc cấp thêm scope:

  * Có thể `UPDATE` row cũ: set `revoked_at = NULL, updated_at = now(), granted_scopes = ...` (coi như revive).
  * Hoặc insert row mới (partial unique sẽ đảm bảo chỉ một active).
* Access token KHÔNG lưu ở DB → Redis với TTL 3500s, key: `google:access_token:{user_id}:{scope_hash}`, index set.

**Key Rotation:**

* Mỗi key encryption có `kid` (ví dụ "v1", "v2").
* Khi encrypt, lưu `token_kid = current_kid`.
* Khi decrypt, chọn key dựa trên `token_kid`.
* Có job re-encrypt: chạy ngoài giờ, đọc grant có `token_kid != newest_kid`, decrypt bằng old key, encrypt bằng new key, update row.

### users (chỉnh nhẹ) – sở hữu bởi user-service

```sql
ALTER TABLE users
  ADD COLUMN auth_provider_primary VARCHAR(50) DEFAULT 'local';
-- 'local' | 'google' | ...
-- Local login enabled = password_hash IS NOT NULL
-- Google login enabled = EXISTS (SELECT 1 FROM user_identities WHERE user_id = users.id AND provider = 'google' AND unlinked_at IS NULL)
```

### google_calendar_links (mới – G3+) – sở hữu bởi meeting-service

```sql
CREATE TABLE google_calendar_links (
  id                         BIGSERIAL PRIMARY KEY,
  meeting_id                 BIGINT NOT NULL,   -- scalar meeting id; FK only if same DB/schema
  user_id                    BIGINT NOT NULL,   -- scalar user id; FK only if same DB/schema
  audiomind_calendar_request_id UUID NOT NULL,  -- idempotency key
  google_calendar_event_id   VARCHAR(255),
  google_calendar_id         VARCHAR(255) NOT NULL DEFAULT 'primary',
  conference_id              VARCHAR(255),
  meet_space_name            TEXT,              -- spaces/{spaceId}
  meet_uri                   TEXT,              -- https://meet.google.com/xxx-yyy-zzz
  hangout_link               TEXT,
  conference_status          VARCHAR(50) NOT NULL DEFAULT 'pending',
  creation_status            VARCHAR(50) NOT NULL DEFAULT 'creating',
  -- creating | success | failed
  conference_record_name     TEXT,              -- điền sau meeting kết thúc
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(meeting_id, user_id),
  UNIQUE(audiomind_calendar_request_id)
);

-- Partial unique index: chỉ enforce uniqueness khi google_calendar_event_id NOT NULL
CREATE UNIQUE INDEX ux_google_calendar_event_id_present
  ON google_calendar_links(google_calendar_event_id)
  WHERE google_calendar_event_id IS NOT NULL;
```

### google_import_jobs (mới – G4+) – sở hữu bởi processing-service

```sql
CREATE TABLE google_import_jobs (
  id                    BIGSERIAL PRIMARY KEY,
  meeting_id            BIGINT NOT NULL,   -- scalar
  user_id               BIGINT NOT NULL,   -- scalar
  conference_record_name TEXT,
  job_type              VARCHAR(50) NOT NULL,   -- 'transcript'
  status                VARCHAR(50) NOT NULL DEFAULT 'pending',
  -- pending|polling|completed|failed|no_artifact|permission_denied|unsupported_language
  attempt_count         INT NOT NULL DEFAULT 0,
  max_attempts          INT NOT NULL DEFAULT 8,
  last_attempted_at     TIMESTAMPTZ,
  next_retry_at         TIMESTAMPTZ,
  error_code            VARCHAR(100),
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_import_jobs_poll
  ON google_import_jobs(status, next_retry_at)
  WHERE status IN ('pending', 'polling');
```

### google_meet_artifacts (mới – G4+) – sở hữu bởi processing-service

```sql
CREATE TABLE google_meet_artifacts (
  id                     BIGSERIAL PRIMARY KEY,
  meeting_id             BIGINT NOT NULL,   -- scalar
  conference_record_name TEXT NOT NULL,
  artifact_type          VARCHAR(50) NOT NULL,   -- 'transcript'
  artifact_name          TEXT NOT NULL UNIQUE,
  state                  VARCHAR(50),            -- STARTED | ENDED
  import_status          VARCHAR(50) NOT NULL DEFAULT 'pending',
  entry_count            INT,
  imported_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(artifact_name)
);
```

---

## 6. Backend API Contract (Cập nhật)

### user-service

| Endpoint                        | Method | Auth                        | Ghi chú                                                                         |
| ------------------------------- | ------ | --------------------------- | ------------------------------------------------------------------------------- |
| `/auth/google/start`            | GET    | Public                      | Tạo opaque state, redirect Google OAuth                                         |
| `/auth/google/callback`         | GET    | Public (state param)        | GET+DELETE state, exchange code, tạo ticket, redirect FE                        |
| `/auth/google/exchange-ticket`  | POST   | Public                      | Atomic GETDEL ticket, trả JWT                                                   |
| `/auth/google/link/start`       | POST   | Audiomind JWT               | Bắt đầu link flow, body: `{ additionalScopes: [] }`                             |
| `/auth/google/link/callback`    | GET    | State param                 | Exchange code, lưu/revive token, **redirect** FE success/error (không trả JSON) |
| `/users/me/google/grant`        | DELETE | Audiomind JWT               | Revoke API grant (giữ identity), xóa Redis cache                                |
| `/users/me/google/identity`     | DELETE | Audiomind JWT               | Unlink Google identity (có guard)                                               |
| `/users/me/google/status`       | GET    | Audiomind JWT               | Trả linked status + scopes                                                      |
| `/internal/google/access-token` | POST   | **Service-to-service only** | Cấp access token cho internal service, yêu cầu auth (mTLS/internal JWT)         |

**Internal access-token endpoint security:**

```yaml
- Không expose public qua Caddy/reverse proxy.
- Chỉ cho meeting-service và processing-service gọi.
- Bắt buộc service-to-service auth:
  * mTLS (mutual TLS) hoặc
  * internal JWT signed bằng service secret (HS256/RS256) hoặc
  * HMAC service token với rotation.
- Request phải chứa:
  {
    "callerService": "meeting-service",
    "userId": 12345,
    "requiredScopes": ["https://www.googleapis.com/auth/calendar.events"]
  }
- user-service verify callerService allowed.
- Response chỉ trả short-lived access token (TTL ≤ 3600s), không trả refresh token.
- Không log access token.
- Audit log: callerService, userId, scopeHash, traceId, success/fail.
```

**One-time ticket exchange:**

```
POST /auth/google/exchange-ticket
Body: { "ticket": "string" }
Response: { "token": "<audiomind_jwt>", "user": { "id": "...", "email": "...", "name": "..." } }
Errors:
- GOOGLE_LOGIN_TICKET_INVALID (ticket không tồn tại hoặc malformed)
- GOOGLE_LOGIN_TICKET_USED (nếu có used marker)
- GOOGLE_LOGIN_TICKET_EXPIRED (optional, chỉ nếu lưu expired marker)
```

**Incremental consent request:**

```
POST /auth/google/link/start
Body: { "additionalScopes": ["https://www.googleapis.com/auth/calendar.events"] }
→ OAuth consent với scopes bổ sung (access_type=offline, include_granted_scopes=true)
→ Merge vào granted_scopes hiện tại (revive grant nếu cần)
```

### meeting-service

| Endpoint                               | Method | Auth                       | Ghi chú                                                             |
| -------------------------------------- | ------ | -------------------------- | ------------------------------------------------------------------- |
| `/meetings/{id}/google/calendar-event` | POST   | Audiomind JWT + owner gate | Tạo Calendar event + Meet link (idempotent, trả về existing nếu có) |
| `/meetings/{id}/google/status`         | GET    | Audiomind JWT + owner gate | Trả tổng hợp Google status (gồm creation_status)                    |

### processing-service

| Endpoint                                  | Method | Auth                       | Ghi chú        |
| ----------------------------------------- | ------ | -------------------------- | -------------- |
| `/meetings/{id}/google/import-transcript` | POST   | Audiomind JWT + owner gate | Tạo import job |
| `/meetings/{id}/google/import-status`     | GET    | Audiomind JWT + owner gate | Trả job status |
| `/internal/google/jobs/poll`              | POST   | Internal                   | Cron trigger   |

---

## 7. OAuth / Security Checklist (Cập nhật)

| Item                      | Implementation                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth state               | Opaque random token (32+ bytes), Redis TTL 10 phút, `GET+DELETE` atomically, không log state value. State chỉ chứa metadata, không chứa secrets.              |
| Redirect after validation | `redirect_after` phải nằm trong allowlist (domain app.audiomind.pro.vn, localhost dev). Chặn open redirect.                                                   |
| ID token verification     | Dùng thư viện chính thức của Google cho Java/Spring: `GoogleIdTokenVerifier`. Verify issuer, audience (client ID), expiry, `email_verified`.                  |
| Nonce (trong state)       | Lưu nonce trong Redis state, verify khi callback.                                                                                                             |
| PKCE                      | Optional với server-side flow, recommend thêm cho an toàn.                                                                                                    |
| Redirect URI              | Exact match, không wildcard, validate server-side.                                                                                                            |
| One-time login ticket     | Opaque high-entropy random, Redis TTL 60–120s, atomic GETDEL, có used marker. Không log ticket value. **FE route không load analytics trước khi xóa ticket.** |
| Refresh token             | AES-256-GCM encrypted, lưu `token_kid` để rotate key.                                                                                                         |
| Access token              | Redis với TTL ≤3500s, key `google:access_token:{user_id}:{scope_hash}`, có index set, private network, có thể encrypt value.                                  |
| Log safety                | KHÔNG log: token, refresh_token, client_secret, IV, key, ticket value, state value (chỉ log hash prefix nếu cần).                                             |
| Scope minimization        | Chỉ xin scope cần thiết, incremental consent, dùng full URL constants.                                                                                        |
| Sensitive scope           | Submit verification trước public launch.                                                                                                                      |
| Restricted scope          | Delay đến có security assessment.                                                                                                                             |
| Revocation                | Gọi Google revocation endpoint khi revoke grant, xóa Redis cache (index set).                                                                                 |
| Token rotation            | Nếu Google trả refresh_token mới → update DB (revive nếu cần), cập nhật `updated_at`.                                                                         |
| Audit log                 | userId, action, timestamp, success/fail, traceId, callerService (cho internal).                                                                               |
| Error no secrets          | Error response không chứa token, raw Google error, email, code, state.                                                                                        |
| Key rotation              | Có job re-encrypt grants cũ với key mới, dùng `token_kid`.                                                                                                    |
| FE success route          | `Referrer-Policy: no-referrer` hoặc `strict-origin`, gọi `replaceState` xoá query, không gửi ticket vào analytics.                                            |

---

## 8. Error / UX Validation Mapping

### 8.1 Google OAuth / Calendar / Meet API errors

| Error Code                             | HTTP    | Retryable              | FE Action                                | User Message                                                                                                                       |
| -------------------------------------- | ------- | ---------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_NOT_LINKED`                    | 400     | ❌                      | Hiện nút "Kết nối Google"                | "Bạn chưa kết nối Google Account."                                                                                                 |
| `GOOGLE_ACCESS_TOKEN_EXPIRED`          | 401     | ✅ (auto)               | Auto refresh internal, không hiển thị FE | Không hiển thị.                                                                                                                    |
| `GOOGLE_REFRESH_TOKEN_REVOKED`         | 401     | ❌                      | Trigger re-link                          | "Phiên Google đã bị thu hồi. Vui lòng kết nối lại."                                                                                |
| `GOOGLE_TOKEN_EXPIRED`                 | 401     | ❌                      | Trigger re-link                          | "Phiên Google hết hạn. Vui lòng kết nối lại."                                                                                      |
| `GOOGLE_SCOPE_MISSING`                 | 403     | ❌                      | Trigger incremental consent              | "Audiomind cần thêm quyền Google để thực hiện thao tác này."                                                                       |
| `GOOGLE_PERMISSION_DENIED`             | 403     | ❌                      | Hiện giải thích + fallback               | "Bạn cần là organizer hoặc participant có quyền để import transcript."                                                             |
| `GOOGLE_MEET_TRANSCRIPT_UNAVAILABLE`   | 404     | ❌                      | Suggest upload audio                     | "Không tìm thấy transcript. Transcription có thể chưa được bật trong meeting hoặc ngôn ngữ không được hỗ trợ."                     |
| `GOOGLE_MEET_UNSUPPORTED_LANGUAGE`     | 422     | ❌                      | Suggest Deepgram upload                  | "Google Meet transcript không hỗ trợ ngôn ngữ này (chỉ EN, FR, DE, IT, JA, KO, PT, ES). Hãy upload audio để Audiomind transcribe." |
| `GOOGLE_WORKSPACE_REQUIRED`            | 403     | ❌                      | Inform + suggest fallback                | "Google Meet transcript yêu cầu Google Workspace Business Standard+ hoặc edition tương đương."                                     |
| `GOOGLE_MEET_ARTIFACT_PENDING`         | 202     | ✅                      | Polling spinner                          | "Đang chờ Google Meet xử lý transcript..."                                                                                         |
| `GOOGLE_MEET_API_UNAVAILABLE`          | 503     | ✅                      | Retry later                              | "Google Meet API tạm thời không khả dụng."                                                                                         |
| `GOOGLE_OAUTH_STATE_INVALID`           | 400     | ❌                      | Restart OAuth flow                       | "Phiên xác thực không hợp lệ. Vui lòng thử lại."                                                                                   |
| `GOOGLE_ACCOUNT_ALREADY_LINKED`        | 409     | ❌                      | Inform                                   | "Google Account này đã được kết nối với tài khoản khác."                                                                           |
| `GOOGLE_EMAIL_CONFLICT`                | 409     | ❌                      | Offer login then link                    | "Email này đã tồn tại. Đăng nhập với email/password rồi kết nối Google."                                                           |
| `GOOGLE_RECORDING_UNAVAILABLE`         | 404     | ❌                      | Inform                                   | "Không tìm thấy recording. Có thể recording chưa được bật trong meeting."                                                          |
| `GOOGLE_CALENDAR_CREATION_IN_PROGRESS` | 202     | ✅                      | Polling spinner                          | "Đang tạo Google Meet link, vui lòng chờ..."                                                                                       |
| `GOOGLE_CALENDAR_CREATION_FAILED`      | 502/400 | ❌ / retry if temporary | Retry or show safe error                 | "Không thể tạo Google Meet link. Vui lòng thử lại."                                                                                |
| `GOOGLE_CANNOT_UNLINK_LAST_IDENTITY`   | 400     | ❌                      | Yêu cầu set password                     | "Bạn không thể ngắt kết nối Google vì không có mật khẩu. Vui lòng đặt mật khẩu trước."                                             |
| `GOOGLE_LOGIN_TICKET_INVALID`          | 400     | ❌                      | Retry login                              | "Phiên đăng nhập không hợp lệ. Vui lòng thử lại."                                                                                  |
| `GOOGLE_LOGIN_TICKET_USED`             | 400     | ❌                      | Retry login                              | "Phiên đăng nhập đã được sử dụng. Vui lòng thử lại."                                                                               |
| `GOOGLE_LOGIN_TICKET_EXPIRED`          | 400     | ❌                      | Retry login                              | "Phiên đăng nhập đã hết hạn. Vui lòng thử lại."                                                                                    |

### 8.2 Browser tab audio capture errors — G3.5

| Error Code                                   | HTTP/UI | Retryable | FE Action                              | User Message                                                                                                      |
| -------------------------------------------- | ------- | --------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `BROWSER_CAPTURE_NOT_SUPPORTED`              | UI      | ❌         | Show fallback UI                       | "Trình duyệt của bạn không hỗ trợ ghi âm tab. Vui lòng dùng Chrome hoặc Edge trên máy tính."                      |
| `DISPLAY_CAPTURE_CANCELLED`                  | UI      | ✅         | Show picker again                      | "Bạn đã huỷ chọn tab. Vui lòng chọn tab Google Meet."                                                             |
| `TAB_AUDIO_NOT_SHARED`                       | UI      | ✅         | Show guide with checkbox instruction   | "Bạn cần chọn tab Google Meet và bật 'Chia sẻ âm thanh của tab'."                                                 |
| `NO_AUDIO_TRACK_DETECTED`                    | UI      | ✅         | Show check instructions                | "Không tìm thấy âm thanh từ tab Google Meet. Hãy đảm bảo bạn đã bật 'Share tab audio' và tab đang phát âm thanh." |
| `MIC_PERMISSION_DENIED`                      | UI      | ✅         | Continue tab-only or ask permission    | "Audiomind không có quyền microphone. Bạn vẫn có thể ghi tab audio hoặc cấp quyền mic để ghi giọng của bạn."      |
| `DISPLAY_CAPTURE_ENDED`                      | UI      | ❌         | Stop/finalize safely                   | "Việc chia sẻ tab đã kết thúc. Audiomind đã dừng ghi âm."                                                         |
| `AUDIO_MIX_FAILED`                           | UI/500  | ✅         | Retry or fallback to mic-only/tab-only | "Lỗi xử lý âm thanh. Vui lòng thử lại hoặc dùng chế độ microphone/tab riêng."                                     |
| `GOOGLE_MEET_TAB_NOT_SELECTED`               | UI      | ✅         | Show guide                             | "Vui lòng chọn đúng tab Google Meet, không chọn cửa sổ hoặc toàn màn hình."                                       |
| `REALTIME_STREAM_FAILED`                     | 500     | ✅         | Retry / fallback                       | "Mất kết nối realtime. Vui lòng kiểm tra mạng và thử lại."                                                        |
| `STT_NO_SPEECH`                              | UI      | ✅         | Check audio/mic                        | "Không nhận diện được giọng nói. Hãy kiểm tra microphone hoặc tab audio."                                         |
| `STT_LANGUAGE_UNSUPPORTED_OR_LOW_CONFIDENCE` | UI      | ✅         | Suggest check language / retry         | "Ngôn ngữ nhận diện không chính xác. Vui lòng nói rõ ràng hơn hoặc thử lại với chế độ tiếng Việt."                |

---

## 9. Realtime Strategy — Kết luận

| Strategy                                         | Feasibility      | Complexity | Cost       | MVP?     | Recommendation                                  |
| ------------------------------------------------ | ---------------- | ---------- | ---------- | -------- | ----------------------------------------------- |
| **Audiomind browser recording (hiện tại)**       | ✅ Đang có        | Minimal    | $0         | ✅        | **Giữ nguyên làm default**                      |
| **G3.5 Browser tab audio capture (Google Meet)** | ✅ (Chrome/Edge)  | Trung bình | $0         | ✅        | **Recommended flow cho Google Meet tiếng Việt** |
| **Post-meeting Google transcript import**        | ✅ (có điều kiện) | Trung bình | $0         | ⚠️ Pilot | Chỉ cho Workspace + 8 ngôn ngữ, không cho VN    |
| **Calendar → Audiomind tab parallel record**     | ✅                | Minimal    | $0         | ✅        | Đã bao gồm trong G3.5                           |
| **Meet Media API**                               | ⚠️ Dev Preview   | Rất cao    | $0 API     | ❌        | Delay đến GA                                    |
| **Bot (Recall.ai, Nylas)**                       | ✅ GA             | Thấp       | $0.5–2/giờ | ⚠️       | Enterprise tier only                            |

**Recommended flow cho Google Meet tiếng Việt (G3.5):**

1. User tạo meeting trong Audiomind hoặc dùng Google Meet link có sẵn từ bên ngoài.
2. Share link với participants.
3. Mở tab Audiomind, chọn mode "Ghi âm Google Meet".
4. Chọn tab Google Meet, bật share tab audio, cho phép mic nếu muốn.
5. Audiomind capture tab audio + mic → Deepgram realtime (tiếng Việt).
6. Kết thúc → Gemini analysis như bình thường.

→ Không cần Google Workspace đặc biệt.
→ Không cần Google native transcript.
→ Deepgram vẫn là STT chính.
→ Giải quyết được vấn đề "mở song song nhưng không thu remote audio".

---

## 10. Testing Plan

Browser picker behavior must be manually smoke-tested on real Chrome/Edge desktop. Unit tests should mock `getDisplayMedia`, `getUserMedia`, audio tracks, and track ended events, but they cannot prove real tab-audio sharing works.

### Unit Tests

```txt
user-service:
  - verifyIdToken(): valid, invalid audience, expired, tampered signature using GoogleIdTokenVerifier.
  - encryptRefreshToken()/decryptRefreshToken(): round-trip, wrong key, token_kid rotation.
  - handleEmailCollision(): new Google, existing Google, local conflict, identity conflict.
  - OAuth state: create opaque state, GET+DELETE, expired state, replay detection.
  - Google sub as identity, not email.
  - One-time ticket: create, atomic exchange (GETDEL), reuse detection, expiry if marker exists.
  - Redis index set for access tokens: SADD, SMEMBERS, DEL on revoke.

meeting-service:
  - createCalendarEvent(): mock Google API, pending to success, terminal failure, retryable failure.
  - Idempotency: double call with same meeting_id creates one placeholder row and one Google API call.
  - Placeholder row creation before Google API call.
  - google_calendar_event_id nullable when creation_status = 'creating'.
  - Owner gate: other user blocked.
  - GOOGLE_SCOPE_MISSING when calendar.events is not granted.
  - Existing successful link returns existing link without creating a new event.
  - Concurrent requests produce one placeholder and one API call.

processing-service:
  - normalizeTranscriptEntry(): all fields, missing participant, missing timestamps.
  - deduplicateImport(): second call skipped.
  - pollJobSchedule(): backoff intervals, no no_artifact before deadline.
  - triggerAnalysis(): reuse existing Gemini pipeline.
  - languageCheck(): unsupported language -> GOOGLE_MEET_UNSUPPORTED_LANGUAGE.
  - no artifact after max attempts -> no_artifact.
  - no artifact before deadline -> still polling.
```

### Integration Tests

```txt
OAuth state & ticket:
  - Valid code + valid state -> redirect with ticket, exchange -> JWT.
  - Invalid state -> GOOGLE_OAUTH_STATE_INVALID.
  - Expired state -> 400.
  - Replay same state -> 400 because state was deleted.
  - Exchange with valid ticket -> success, ticket deleted, used marker set if implemented.
  - Exchange with used ticket -> GOOGLE_LOGIN_TICKET_USED.
  - FE route /auth/google/success removes ticket from URL using replaceState and does not call analytics before removal.
  - Referrer-Policy header is set correctly.

Token lifecycle:
  - Expired access token -> auto refresh -> API call succeeds.
  - Revoked refresh token (invalid_grant) -> GOOGLE_REFRESH_TOKEN_REVOKED.
  - Scope not granted -> GOOGLE_SCOPE_MISSING.
  - Incremental consent -> scopes merged correctly, grant revived if needed.
  - Revoke grant -> Google revocation endpoint called, DB revoked_at set, Redis index set cleared, identity remains.

Internal token endpoint:
  - Public call blocked -> 403/401.
  - Unauthorized service blocked -> 403.
  - Authorized meeting-service allowed and receives access token.
  - Scope missing -> GOOGLE_SCOPE_MISSING.
  - Revoked grant -> GOOGLE_REFRESH_TOKEN_REVOKED.

Calendar event:
  - Success -> creation_status = 'success', google_calendar_event_id not null.
  - Status pending -> poll -> success.
  - API 403 no scope -> GOOGLE_SCOPE_MISSING.
  - Double-click create link -> one DB row, one Google API call.
  - Existing link -> return existing without calling Google again.
  - Placeholder row created before Google call; google_calendar_event_id = null.
  - Retry after timeout uses stable requestId and does not create duplicate event.
  - Terminal failure -> creation_status = 'failed', no retry.

Transcript import:
  - Conference found, transcript ENDED, supported language -> imported, analysis triggered.
  - Conference found, no transcript artifact before deadline -> polling continues.
  - Conference found, no transcript artifact after max attempts -> no_artifact.
  - Conference found, transcript with unsupported language -> unsupported_language.
  - Conference not found yet -> polling continues.
  - Permission denied -> permission_denied terminal.
  - Second import call -> idempotent.

Disconnect & revoke:
  - Revoke grant -> DB revoked_at set, Redis cache cleared, identity remains.
  - Unlink identity -> user_identities.unlinked_at set, cannot login with Google, last-identity guard works.
  - User only has Google login -> GOOGLE_CANNOT_UNLINK_LAST_IDENTITY.
  - Token encrypted with old token_kid can still decrypt; re-encrypt job updates token_kid.
  - Logs contain no token, refresh_token, ticket, state, client_secret, raw Google error, email, code, or state.
```

### G3.5 Browser Tab Audio Capture Tests

#### Unit tests FE

```ts
describe('TabAudioCaptureService', () => {
  it('detects getDisplayMedia support using feature detection, not only browser name');
  it('calls getDisplayMedia with video:true and audio:true');
  it('detects stream.getAudioTracks().length === 0 and throws TAB_AUDIO_NOT_SHARED');
  it('handles user cancel or AbortError as DISPLAY_CAPTURE_CANCELLED');
  it('handles display capture ended via track.onended as DISPLAY_CAPTURE_ENDED');
  it('calls getUserMedia for microphone when Tab + Mic mode is selected');
  it('creates AudioContext and mixes tab + mic streams in mode C');
  it('handles AudioContext failure as AUDIO_MIX_FAILED');
  it('does not log raw audio chunks, stream IDs, deviceId, provider responses, or transcripts');
});

describe('RecordingSourceSelector', () => {
  it('renders options: Microphone / Google Meet tab audio / Tab + Microphone');
  it('disables tab options when getDisplayMedia is unsupported');
  it('shows help text for choosing Google Meet tab and enabling share tab audio');
  it('continues tab-only mode when mic permission is denied but tab audio is valid');
  it('does not call Gemini when transcript rows = 0');
});
```

#### Manual browser tests Chrome/Edge desktop

* Google Meet tab + share tab audio ON → UI shows "Tab audio detected" → transcript appears for Vietnamese speech.
* Google Meet tab + share tab audio OFF → UI warns `TAB_AUDIO_NOT_SHARED` or `NO_AUDIO_TRACK_DETECTED`.
* Wrong tab selected → UI warns `GOOGLE_MEET_TAB_NOT_SELECTED` if detectable, otherwise `NO_AUDIO_TRACK_DETECTED`.
* Tab audio only → remote audio transcribes.
* Tab + mic → both local and remote speech appear in transcript.
* Stop sharing from browser toolbar → recording finalizes automatically and does not get stuck.
* Existing mic-only realtime still works.
* Verify current Deepgram config: explicit `language=vi` if supported, or auto language detection only if this smoke test passes.

#### Firefox/Safari/mobile fallback tests

* Firefox desktop: feature detection disables tab audio mode or shows unsupported message unless usable audio track is confirmed.
* Safari desktop: feature detection disables tab audio mode or shows unsupported message unless usable audio track is confirmed.
* iOS/Android mobile: `getDisplayMedia` unavailable or unusable → tab audio options disabled/hidden.
* Mic-only mode remains available where browser/device supports microphone capture.

#### Vietnamese test script

Remote participant (tab audio) says:

```txt
Mèo xanh một một một.
Chuối tím hai hai hai.
Xe đỏ ba ba ba.
```

Local user (microphone) says:

```txt
Tôi nghe rõ.
Cảm ơn bạn.
```

Expected transcript contains at least:

* mèo xanh, một một một
* chuối tím, hai hai hai
* xe đỏ, ba ba ba
* tôi nghe rõ, cảm ơn bạn

#### Negative tests

* Headphones plugged in: mic-only does not capture remote audio reliably; tab capture should.
* User denies mic but tab audio works.
* User denies display capture.
* Browser unsupported.
* Network disconnect during realtime stream → safe error handling and retry/fallback.
* No transcript rows → no Gemini analysis.

### Production Smoke Tests

* Google login end-to-end: callback redirect về FE, exchange ticket, nhận JWT, URL không còn `?ticket`.
* FE success route không leak ticket: check network, console, analytics mock.
* Link Google từ existing email/password account: callback redirect success.
* Create Calendar event → Meet link accessible and idempotent.
* Double-click "Tạo Meet link" → chỉ một event trong Google Calendar.
* Import transcript từ meeting thực có transcript và ngôn ngữ được hỗ trợ.
* Import transcript từ meeting không có transcript → `no_artifact` sau deadline với fallback message đúng.
* Revoke grant → token revoked, Redis cleared, user vẫn login được bằng Google nếu identity còn active.
* Unlink identity → không login Google được nữa, vẫn đăng nhập bằng password nếu password exists.
* Disconnect khi chỉ có Google login → báo lỗi set password trước.
* Internal access-token endpoint chỉ cho phép service đã authorize.
* Scope constants trong code dùng full URL, không có shorthand `media.readonly`.

### Production Smoke Tests — G3.5

* User có thể chọn mode "Google Meet tab audio" trên Chrome/Edge, chọn tab, bật share audio, và transcript tiếng Việt xuất hiện trong vài giây.
* Nếu user không bật share audio, UI hiển thị lỗi rõ ràng, không im lặng fail.
* Khi user stop sharing từ browser toolbar, recording kết thúc đúng cách, không bị treo.
* Không log raw audio, raw transcript, provider response, token, hoặc deviceId.
* One-active-session guard hoạt động: không thể start hai recording cùng lúc.

---

## 11. Decision Matrix

| Feature                                                     | Quyết định                           | Lý do                                                                 |
| ----------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Google Login — OIDC only                                    | **Build now**                        | No sensitive scope, không cần verification                            |
| Link Google Account                                         | **Build now**                        | Prerequisite cho Calendar/Meet                                        |
| Calendar + Meet scheduling                                  | **Build next (G3)**                  | Clear value, sensitive scope cần verification song song               |
| **G3.5 Google Meet tab audio capture (VN)**                 | **Build near-term (sau/đi cùng G3)** | **Core cho user Việt, tránh limitation của Google native transcript** |
| Post-meeting transcript (Workspace + ngôn ngữ đủ điều kiện) | **Build later — pilot**              | **Tiếng Việt không hỗ trợ, Workspace required**                       |
| ArtifactConfig pre-configure                                | **Build với G3/G4 (optional)**       | Scope hiện non-sensitive, verify Cloud Console trước prod             |
| Recording import (Drive)                                    | **Build later**                      | Restricted scope, ưu tiên `drive.meet.readonly`, security assessment  |
| Meet Media API                                              | **Avoid (now)**                      | Developer Preview, all participants enrolled                          |
| Bot (Recall.ai)                                             | **Needs research/approval**          | Enterprise tier, cost                                                 |
| Browser extension                                           | **Needs research**                   | Sau MVP                                                               |
| Bot/headless/scraping                                       | **Avoid**                            | ToS violation                                                         |
| Replace current auth                                        | **Avoid**                            | Không cần, additive pattern                                           |
| Thay Deepgram STT                                           | **Avoid**                            | Project constraint                                                    |

---

## 12. Final Recommendation

### Build now / near-term (G0–G3.5)

1. **G0 Google Cloud Setup** (1–2 ngày)
2. **G1 Google Login** (3–5 ngày)
3. **G2 Link Google Account** (2–3 ngày)
4. **G3 Calendar + Meet Scheduling** (3–5 ngày)
5. **G3.5 Google Meet Tab Audio Capture for Vietnamese meetings** (3–5 ngày, có thể làm song song với G3)

### Pilot later (G4)

* **G4 Post-meeting Google transcript import** (chỉ pilot, không phải core cho VN). Thu thập data trước khi mở rộng.

### Avoid / delay

* Meet Media API (đến GA)
* Drive recording import (security assessment)
* Bot/headless/scraping (ToS violation)

### Effort estimate (cập nhật)

| Phase                         | Effort                    |
| ----------------------------- | ------------------------- |
| G0 Cloud setup                | 1–2 ngày                  |
| G1 Google Login               | 3–5 ngày                  |
| G2 Link Account               | 2–3 ngày                  |
| G3 Calendar scheduling        | 3–5 ngày                  |
| **G3.5 Tab audio capture**    | **3–5 ngày**              |
| G4 Transcript import (pilot)  | 5–7 ngày (sau G3)         |
| OAuth verification (parallel) | 1–4 tuần (Google process) |
| **Tổng G1–G3.5**              | **~12–18 ngày dev**       |

---

## Nguồn tham khảo (cập nhật)

| Tài liệu                              | URL                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Meet REST API overview                | https://developers.google.com/workspace/meet/api/guides/overview                           |
| Work with Meet artifacts              | https://developers.google.com/workspace/meet/api/guides/artifacts                          |
| Meet Media API overview               | https://developers.google.com/workspace/meet/media-api/guides/overview                     |
| Meet Media API scopes                 | https://developers.google.com/workspace/meet/media-api/guides/authenticate-authorize       |
| Meet spaces — create/manage           | https://developers.google.com/workspace/meet/api/guides/meeting-spaces                     |
| Meet spaces — ArtifactConfig          | https://developers.google.com/workspace/meet/api/guides/meeting-spaces-configuration       |
| Meet spaces.patch (updateMask)        | https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces/patch            |
| Meet REST API scopes                  | https://developers.google.com/workspace/meet/api/guides/authenticate-authorize             |
| GIS — Authorization Code Model        | https://developers.google.com/identity/oauth2/web/guides/use-code-model                    |
| Verify Google ID Token (Java)         | https://developers.google.com/identity/oauth2/web/guides/verify-google-id-token#java       |
| Calendar API — Create events          | https://developers.google.com/workspace/calendar/api/guides/create-events                  |
| OAuth 2.0 Scopes for Google APIs      | https://developers.google.com/identity/protocols/oauth2/scopes                             |
| Google Meet transcript official help  | https://support.google.com/meet/answer/12849897                                            |
| Google Workspace Updates (March 2025) | https://workspaceupdates.googleblog.com/2025/03/google-meet-transcript-more-languages.html |
| OAuth for Web Server (offline access) | https://developers.google.com/identity/protocols/oauth2/web-server                         |
| Token revocation                      | https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevocation         |
| OAuth state best practices (OWASP)    | https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html#state-parameter     |
| Drive scopes for Meet recordings      | https://developers.google.com/drive/api/guides/about-auth (verify `drive.meet.readonly`)   |
| **MDN `getDisplayMedia`**             | https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia              |
| **MDN `getUserMedia`**                | https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia                 |
| **MDN Web Audio API**                 | https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API                             |
| **Deepgram Vietnamese STT**           | (Verify official Deepgram docs for language code `vi` and realtime support)                |

Đánh giá: **bản v2.6 Final đã đạt mức có thể chốt làm spec nền cho backlog**. Các lỗi chính của v2.5 đã được sửa: title/status đúng, Architecture không còn code fence lỗi, Error/UX đã tách nhóm, G4 warning heading đã sạch, G3.5 có non-goals, implementation slices, note Deepgram config, manual browser smoke và clarification G3.5 không phụ thuộc OAuth/Calendar. 

## Chấm điểm

| Mục                               |                          Điểm |
| --------------------------------- | ----------------------------: |
| Định hướng sản phẩm cho user Việt |                        9.5/10 |
| G3.5 tab audio capture strategy   |                        9.3/10 |
| OAuth/Google integration roadmap  |                          9/10 |
| Architecture clarity              |                        8.8/10 |
| ErrorUX                           |                          9/10 |
| Testing plan                      |                          9/10 |
| Markdown readiness                |                        8.8/10 |
| Sẵn sàng chốt spec                |                        **Có** |
| Sẵn sàng giao agent implement     | **Có, nhưng phải chia slice** |

## Điểm đã sửa tốt

Phần **G3.5** hiện đã đúng trọng tâm: hỗ trợ Google Meet tiếng Việt bằng browser tab audio capture, không phụ thuộc Google Meet native transcript, không cần Meet Media API, không cần bot/headless, và vẫn giữ Deepgram/Gemini làm core pipeline. Spec cũng ghi rõ G3.5 có thể dùng với Meet link bên ngoài, không bắt buộc Google OAuth hoặc Calendar G3. 

Phần **implementation slices** rất cần thiết và đã thêm đúng: G3.5-A source selector, G3.5-B tab capture, G3.5-C mixer, G3.5-D realtime integration + metadata, G3.5-E ErrorUX/tests/manual smoke. Điều này giúp tránh agent ôm quá nhiều file một lần. 

Phần **testing/manual smoke** đã đủ hướng: unit test mock browser APIs, manual Chrome/Edge, fallback Firefox/Safari/mobile, Vietnamese test script, negative tests. Đây là đúng vì browser picker/tab audio không thể chứng minh hoàn toàn bằng unit test. 

## Còn vài note nhỏ, không blocker

1. **Changelog v2.4 → v2.5 vẫn giữ trong file.** Không sai, nhưng nếu muốn file gọn hơn có thể chuyển thành “Previous changelog archive”. Không cần sửa nếu bạn muốn giữ lịch sử.

2. Trong bảng so sánh G3 vẫn có shorthand `calendar.events` và `meetings.space.created`. Vì các scope constants phía trên đã ghi full URL nên không nghiêm trọng. Khi viết prompt implement, nhắc agent **không copy shorthand**, phải dùng full URL constants.

3. G3.5 đang ghi MVP target Chrome/Edge/Chromium. Đúng cho roadmap, nhưng khi code nên vẫn dùng **feature detection trước**, browser detection chỉ để hướng dẫn UX.

4. Trước khi implement G3.5-C mixer, phải test thật việc giữ/stop video track trên Chrome/Edge. Spec đã cảnh báo đúng, không cần sửa thêm. 

## Quyết định cuối

**Có thể chốt bản v2.6 Final.** Không cần thêm vòng sửa roadmap nữa.

Thứ tự làm tiếp nên là:

```text
1. Chốt file v2.6 Final vào docs/specs.
2. Tạo issue/prompt triển khai G1 Google Login nếu muốn làm Google auth trước.
3. Hoặc tạo issue/prompt triển khai G3.5-A nếu ưu tiên fix bài toán Google Meet tiếng Việt.
```

Nếu ưu tiên sản phẩm cho người dùng Việt, tôi khuyên sau khi roadmap chốt thì triển khai theo thứ tự:

```text
G3.5-A — FE source selector + permission UX
G3.5-B — Tab audio capture + detection
G3.5-C — Tab + mic mixer
G3.5-D — Realtime pipeline integration + metadata
G3.5-E — ErrorUX + tests + manual smoke
```

Bản này đủ tốt để đưa cho coding agent làm việc theo từng slice.
