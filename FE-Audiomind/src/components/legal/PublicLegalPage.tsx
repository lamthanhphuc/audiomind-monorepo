import PublicSiteFooter from './PublicSiteFooter'
import type { PublicLegalKind } from '../../utils/publicRoutes'
import { PUBLIC_LEGAL_PATHS } from '../../utils/publicRoutes'

type PublicLegalPageProps = {
  kind: PublicLegalKind
}

const UPDATED_AT = '04/07/2026'

export default function PublicLegalPage({ kind }: PublicLegalPageProps) {
  const isPrivacy = kind === 'privacy'
  const title = isPrivacy ? 'Chính sách quyền riêng tư' : 'Điều khoản dịch vụ'
  const otherKind: PublicLegalKind = isPrivacy ? 'terms' : 'privacy'
  const otherLabel = isPrivacy ? 'Điều khoản dịch vụ' : 'Chính sách quyền riêng tư'

  return (
    <main className="public-legal" data-testid={`public-legal-${kind}`}>
      <header className="public-legal__header">
        <a className="public-legal__brand" href="/" data-testid="public-legal-home">
          <span className="public-legal__logo-mark" aria-hidden="true" />
          AudioMind
        </a>
        <nav className="public-legal__header-nav" aria-label="Tài liệu pháp lý">
          <a href={PUBLIC_LEGAL_PATHS[otherKind]}>{otherLabel}</a>
          <a href="/">Đăng nhập</a>
        </nav>
      </header>

      <article className="public-legal__article">
        <p className="public-legal__updated">Cập nhật lần cuối: {UPDATED_AT}</p>
        <h1>{title}</h1>
        {isPrivacy ? <PrivacyPolicyBody /> : <TermsOfServiceBody />}
      </article>

      <PublicSiteFooter />
    </main>
  )
}

function PrivacyPolicyBody() {
  return (
    <div className="public-legal__body">
      <section>
        <h2>1. AudioMind là gì và thông tin liên hệ</h2>
        <p>
          AudioMind là nền tảng hỗ trợ ghi âm cuộc họp, chuyển lời nói thành văn bản (transcript),
          tóm tắt và phân tích nội dung bằng AI để người dùng quản lý kiến thức họp hiệu quả hơn.
        </p>
        <p>
          Đơn vị vận hành sản phẩm: <strong>AudioMind</strong>.
        </p>
        <ul>
          <li>Website ứng dụng: <a href="https://app.audiomind.pro.vn">https://app.audiomind.pro.vn</a></li>
          <li>Email hỗ trợ / bảo vệ dữ liệu: <a href="mailto:support@audiomind.pro.vn">support@audiomind.pro.vn</a></li>
        </ul>
      </section>

      <section>
        <h2>2. Dữ liệu cá nhân và dữ liệu Google được xử lý</h2>
        <p>Tùy cách bạn sử dụng dịch vụ, AudioMind có thể xử lý các nhóm dữ liệu sau:</p>

        <h3>2.1. Tài khoản AudioMind</h3>
        <ul>
          <li>Tên đăng nhập, email, mật khẩu đã băm (không lưu mật khẩu dạng rõ).</li>
          <li>Thông tin gói dịch vụ, hạn mức sử dụng và lịch sử thanh toán liên quan tài khoản.</li>
        </ul>

        <h3>2.2. Google Sign-In (đăng nhập bằng Google)</h3>
        <p>
          Khi bạn chọn đăng nhập bằng Google, AudioMind chỉ yêu cầu các scope danh tính:
          <code>openid</code>, <code>email</code>, <code>profile</code>.
          Từ đó chúng tôi nhận và lưu định danh tài khoản Google (subject ID), email và tên hiển thị.
        </p>

        <h3>2.3. Tích hợp Google (chỉ khi bạn chủ động kết nối)</h3>
        <p>
          Sau khi đã đăng nhập AudioMind, nếu bạn bật kết nối Google trong phần tích hợp, hệ thống có thể
          yêu cầu thêm các scope sau (không bắt buộc khi chỉ đăng nhập):
        </p>
        <ul>
          <li>
            <code>https://www.googleapis.com/auth/calendar.events</code>
            {' '}— tạo hoặc cập nhật sự kiện lịch liên quan cuộc họp.
          </li>
          <li>
            <code>https://www.googleapis.com/auth/gmail.send</code>
            {' '}— gửi email mời chia sẻ cuộc họp thay mặt bạn.
          </li>
        </ul>
        <p>
          Luồng kết nối tích hợp luôn kèm các scope danh tính (<code>openid</code>, <code>email</code>,
          <code>profile</code>) cùng các scope bổ sung bạn chọn cấp. AudioMind không yêu cầu quyền truy cập
          kho tệp đám mây ngoài hai scope lịch và gửi email nêu trên.
        </p>

        <h3>2.4. Nội dung họp do bạn tạo trên AudioMind</h3>
        <ul>
          <li>File âm thanh tải lên hoặc ghi realtime, transcript, tóm tắt, phân tích AI, ghi chú và siêu dữ liệu cuộc họp.</li>
          <li>Thông tin chia sẻ cuộc họp (email người được mời, vai trò xem).</li>
        </ul>

        <h3>2.5. Dữ liệu kỹ thuật</h3>
        <ul>
          <li>Nhật ký kỹ thuật cần thiết để vận hành, bảo mật và khắc phục sự cố.</li>
        </ul>
      </section>

      <section>
        <h2>3. Mục đích sử dụng từng nhóm dữ liệu</h2>
        <ul>
          <li><strong>Tài khoản AudioMind:</strong> xác thực, quản lý phiên đăng nhập, phân quyền và cung cấp gói dịch vụ.</li>
          <li><strong>Google Sign-In:</strong> tạo hoặc liên kết tài khoản, nhận diện người dùng và hiển thị thông tin cơ bản.</li>
          <li><strong>Scope Calendar/Gmail (khi được cấp):</strong> thực hiện đúng tính năng bạn yêu cầu (sự kiện lịch, gửi email mời), không dùng cho quảng cáo.</li>
          <li><strong>Nội dung họp:</strong> cung cấp transcript, tóm tắt, phân tích AI và các tính năng quản lý họp bạn đã chọn.</li>
          <li><strong>Dữ liệu kỹ thuật:</strong> bảo mật, giám sát ổn định hệ thống và hỗ trợ khách hàng.</li>
        </ul>
      </section>

      <section>
        <h2>4. Không bán dữ liệu Google</h2>
        <p>
          AudioMind <strong>không bán</strong> dữ liệu người dùng Google, không dùng dữ liệu Google để phục vụ
          quảng cáo của bên thứ ba, và không chuyển giao dữ liệu Google để đổi lấy tiền hoặc lợi ích tương đương.
        </p>
      </section>

      <section>
        <h2>5. Chia sẻ dữ liệu</h2>
        <p>Chúng tôi không chia sẻ dữ liệu cá nhân hoặc dữ liệu Google của bạn, trừ các trường hợp sau:</p>
        <ul>
          <li>
            <strong>Nhà cung cấp hạ tầng cần thiết để vận hành:</strong> ví dụ máy chủ đám mây, cơ sở dữ liệu,
            dịch vụ nhận dạng giọng nói hoặc mô hình AI được dùng để xử lý nội dung họp theo yêu cầu của bạn.
          </li>
          <li>
            <strong>Khi pháp luật yêu cầu:</strong> nếu có yêu cầu hợp pháp từ cơ quan có thẩm quyền.
          </li>
          <li>
            <strong>Theo chỉ định của bạn:</strong> ví dụ khi bạn chia sẻ cuộc họp với người khác trong AudioMind.
          </li>
        </ul>
      </section>

      <section>
        <h2>6. Bảo mật</h2>
        <ul>
          <li>Truyền tải qua HTTPS.</li>
          <li>Kiểm soát truy cập theo tài khoản và phiên đăng nhập.</li>
          <li>
            Refresh token OAuth Google (khi bạn kết nối tích hợp hoặc đăng nhập Google có cấp refresh token)
            được mã hóa trước khi lưu trong cơ sở dữ liệu.
          </li>
          <li>Access token Google được lưu tạm trong bộ nhớ đệm máy chủ với thời hạn ngắn (tối đa khoảng một giờ, theo hạn của Google trừ đi biên an toàn).</li>
        </ul>
      </section>

      <section>
        <h2>7. Lưu trữ token, xóa dữ liệu và thu hồi quyền Google</h2>
        <ul>
          <li>
            <strong>Refresh token:</strong> được lưu ở dạng đã mã hóa trong thời gian bạn còn kết nối Google
            với AudioMind (grant còn hiệu lực).
          </li>
          <li>
            <strong>Access token:</strong> chỉ lưu tạm trên máy chủ để gọi API Google, tự hết hạn theo TTL ngắn
            và bị xóa khỏi bộ nhớ đệm khi bạn thu hồi quyền hoặc hủy liên kết.
          </li>
          <li>
            <strong>Thu hồi quyền / ngắt kết nối trong AudioMind:</strong> hệ thống gửi yêu cầu thu hồi token tới Google,
            đánh dấu grant là đã thu hồi (không còn dùng token đó cho yêu cầu mới), và xóa access token đang cache.
            Bản ghi grant đã thu hồi có thể còn trong cơ sở dữ liệu ở trạng thái revoked để phục vụ kiểm soát nội bộ,
            nhưng không được dùng để truy cập dữ liệu Google nữa.
          </li>
          <li>
            <strong>Hủy liên kết danh tính Google:</strong> ngoài việc thu hồi token như trên, AudioMind đánh dấu
            danh tính Google là đã hủy liên kết (không còn dùng để đăng nhập Google cho tài khoản đó), với điều kiện
            tài khoản vẫn còn phương thức đăng nhập khác (ví dụ mật khẩu).
          </li>
          <li>
            Bạn cũng có thể thu hồi quyền tại{' '}
            <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
              Google Account Permissions
            </a>
            .
          </li>
          <li>
            Bạn có thể yêu cầu xóa tài khoản hoặc dữ liệu họp bằng cách liên hệ{' '}
            <a href="mailto:support@audiomind.pro.vn">support@audiomind.pro.vn</a>.
          </li>
        </ul>
      </section>

      <section>
        <h2>8. Thay đổi chính sách</h2>
        <p>
          Chúng tôi có thể cập nhật Chính sách quyền riêng tư này. Phiên bản mới sẽ được đăng tại{' '}
          <a href={PUBLIC_LEGAL_PATHS.privacy}>/privacy</a> kèm ngày cập nhật ở đầu trang.
        </p>
      </section>
    </div>
  )
}

function TermsOfServiceBody() {
  return (
    <div className="public-legal__body">
      <section>
        <h2>1. Chấp nhận điều khoản</h2>
        <p>
          Bằng việc truy cập hoặc sử dụng AudioMind tại{' '}
          <a href="https://app.audiomind.pro.vn">https://app.audiomind.pro.vn</a>, bạn đồng ý với
          Điều khoản dịch vụ này và{' '}
          <a href={PUBLIC_LEGAL_PATHS.privacy}>Chính sách quyền riêng tư</a>.
        </p>
      </section>

      <section>
        <h2>2. Mô tả dịch vụ</h2>
        <p>
          AudioMind cung cấp công cụ ghi âm hoặc tải lên âm thanh cuộc họp, chuyển transcript, tóm tắt và
          phân tích nội dung bằng AI, cùng các tính năng quản lý họp liên quan. Một số tính năng
          (ví dụ kết nối Google Calendar Events hoặc gửi email mời qua Gmail) chỉ hoạt động khi bạn
          chủ động cấp quyền tích hợp sau khi đăng nhập.
        </p>
      </section>

      <section>
        <h2>3. Tài khoản và bảo mật</h2>
        <ul>
          <li>Bạn chịu trách nhiệm bảo mật thông tin đăng nhập và hoạt động diễn ra trên tài khoản của mình.</li>
          <li>Bạn cam kết cung cấp thông tin chính xác khi đăng ký hoặc đăng nhập bằng Google.</li>
          <li>AudioMind có thể tạm ngưng tài khoản nếu phát hiện lạm dụng hoặc vi phạm điều khoản.</li>
        </ul>
      </section>

      <section>
        <h2>4. Nội dung của người dùng</h2>
        <ul>
          <li>Bạn giữ quyền đối với nội dung họp, âm thanh và dữ liệu bạn tải lên hoặc tạo trong AudioMind.</li>
          <li>Bạn cấp cho AudioMind quyền xử lý nội dung đó chỉ để cung cấp và cải thiện dịch vụ theo yêu cầu của bạn.</li>
          <li>Bạn cam kết không tải lên nội dung bất hợp pháp hoặc xâm phạm quyền của bên thứ ba.</li>
        </ul>
      </section>

      <section>
        <h2>5. Gói dịch vụ và thanh toán</h2>
        <p>
          Một số tính năng có thể thuộc gói trả phí. Khi thanh toán, bạn đồng ý với giá và điều kiện
          hiển thị tại thời điểm mua. Việc hoàn tiền (nếu có) tuân theo chính sách hỗ trợ của AudioMind
          và quy định pháp luật áp dụng.
        </p>
      </section>

      <section>
        <h2>6. Giới hạn trách nhiệm</h2>
        <p>
          AudioMind nỗ lực cung cấp dịch vụ ổn định nhưng không cam kết không gián đoạn tuyệt đối.
          Trong phạm vi pháp luật cho phép, AudioMind không chịu trách nhiệm đối với thiệt hại gián tiếp,
          mất dữ liệu do lỗi thiết bị của bạn, hoặc nội dung do bên thứ ba cung cấp.
        </p>
      </section>

      <section>
        <h2>7. Chấm dứt sử dụng</h2>
        <p>
          Bạn có thể ngừng sử dụng dịch vụ bất cứ lúc nào. AudioMind có thể ngừng hoặc thay đổi dịch vụ
          với thông báo hợp lý khi cần thiết để bảo trì, bảo mật hoặc tuân thủ pháp luật.
        </p>
      </section>

      <section>
        <h2>8. Liên hệ</h2>
        <p>
          Mọi câu hỏi về Điều khoản dịch vụ, vui lòng gửi tới{' '}
          <a href="mailto:support@audiomind.pro.vn">support@audiomind.pro.vn</a>.
        </p>
      </section>
    </div>
  )
}
