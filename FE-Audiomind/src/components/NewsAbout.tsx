export default function NewsAbout() {
  return (
    <section className="feature-scene news-scene">
      <section className="hero feature-hero feature-hero--news">
        <div className="hero__search">
          <input className="search-input" type="search" placeholder="Tìm bài giảng, môn học, ghi chú..." />
          <span className="search-icon">⌕</span>
        </div>
        <div className="hero__content">
          <h1>Tin tức & Về chúng tôi</h1>
          <p>Cập nhật sự kiện mới và thông tin về nền tảng MIND.</p>
        </div>
      </section>

      <section className="feature-panel news-about">
        <header className="feature-panel__header">
          <h2>Tin nổi bật</h2>
          <span className="feature-chip">Cập nhật mới nhất</span>
        </header>

        <article className="news-featured">
          <h3>MIND hỗ trợ sinh viên học nhanh hơn</h3>
          <p>
            Nền tảng AI phân tích bài giảng giúp rút gọn nội dung và tạo danh sách hành động
            trong 5-10 phút. Giao diện mới tối ưu cho việc đọc nhanh và tập trung vào thông tin
            quan trọng nhất.
          </p>
          <button type="button" className="secondary-cta">Xem chi tiết</button>
        </article>

        <div className="news-grid news-grid--compact">
          <article className="news-card">
            <h3>MIND hỗ trợ sinh viên học nhanh hơn</h3>
            <p>
              Nền tảng AI phân tích bài giảng giúp rút gọn nội dung và tạo danh sách hành động
              trong 5-10 phút.
            </p>
          </article>

          <article className="news-card">
            <h3>Cập nhật tính năng phân tích âm thanh</h3>
            <p>
              Bản mới cho phép nhận diện từ khóa chuyên ngành và trích xuất thông tin quan trọng
              từ file ghi âm.
            </p>
          </article>

          <article className="news-card">
            <h3>Về chúng tôi</h3>
            <p>
              MIND được xây dựng để giúp học tập và hợp tác hiệu quả hơn thông qua AI, với ưu tiên
              tối ưu cho người dùng tiếng Việt.
            </p>
          </article>
        </div>
      </section>
    </section>
  )
}
